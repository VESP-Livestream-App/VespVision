import React, { useEffect, useState, useRef } from 'react';
import { Platform } from 'react-native';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Alert,
  Pressable,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BleManager, Device } from 'react-native-ble-plx';
import { request, PERMISSIONS, RESULTS } from 'react-native-permissions';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Target UUIDs (replace with your device/service/characteristic UUIDs)
// Service UUID (full 128-bit or 16-bit as string)
const TARGET_SERVICE_UUID = '499d163b-be72-4691-a8af-61657909ac11';
// Characteristic UUID to read/write (full 128-bit or 16-bit as string)
const TARGET_CHARACTERISTIC_UUID = 'b793f920-016e-49ea-a4fd-15fe1d21a1a5';
// Key used to persist last connected device id (JS-only aid for reconnect attempts)
const STORAGE_KEY = 'ble.connectedId';

export default function BleScreen() {
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [angleInput, setAngleInput] = useState('0');
  const [timeInput, setTimeInput] = useState('1000');
  // manager and subscription refs
  const managerRef = useRef<BleManager | null>(new BleManager());
  const stateSubRef = useRef<any>(null);
  // heartbeat (polling) ref to monitor connection health
  const heartbeatRef = useRef<number | null>(null);
  const HEARTBEAT_INTERVAL_MS = 2000; // 2s poll interval

  useEffect(() => {
    let mounted = true;

    // On mount: check if there are devices already connected (for the target service)
    (async () => {
      try {
        const mgr = managerRef.current!;
        const serviceFilter = TARGET_SERVICE_UUID ? [TARGET_SERVICE_UUID] : [];
        const connected = await mgr.connectedDevices(serviceFilter);
        if (!mounted) return;
        if (connected && connected.length > 0) {
          ensureDeviceInList(connected[0]);
          setConnectedId(connected[0].id);
          // initialize inputs when there's an existing connection
          setAngleInput('0');
          setTimeInput('1000');
        }

        // Try a JS-level reconnect to a persisted device id (helps across reloads)
        try {
          const stored = await AsyncStorage.getItem(STORAGE_KEY);
          if (!mounted) return;
          if (stored && !connected.find((d) => d.id === stored)) {
            // attempt to connect (may fail if device isn't available or permissions missing)
            try {
              const reopened = await mgr.connectToDevice(stored);
              await reopened.discoverAllServicesAndCharacteristics();
              if (!mounted) return;
              // add to list and mark connected
              setDevices((prev) => {
                if (prev.find((p) => p.id === reopened.id)) return prev;
                return [...prev, reopened];
              });
              ensureDeviceInList(reopened);
              setConnectedId(reopened.id);
            } catch (err) {
              // fail silently; native/OS may prevent reconnect when app was closed
              console.warn('auto-reconnect failed', err);
            }
          }
        } catch (e) {
          console.warn('read stored connected id failed', e);
        }
      } catch (e) {
        console.warn('connectedDevices check failed', e);
      }
    })();

    return () => {
      mounted = false;
      try {
        // stop any scanning and remove subscription
        managerRef.current?.stopDeviceScan();
        if (stateSubRef.current?.remove) stateSubRef.current.remove();
        // clear heartbeat interval if running
        if (heartbeatRef.current != null) {
          clearInterval(heartbeatRef.current as unknown as number);
          heartbeatRef.current = null;
        }
        managerRef.current?.destroy();
        managerRef.current = null;
      } catch (e) {
        // ignore
      }
    };
  }, []);

  // Heartbeat: poll to detect lost connections when `connectedId` is set
  useEffect(() => {
    // stop any existing heartbeat
    function stopHeartbeat() {
      if (heartbeatRef.current != null) {
        clearInterval(heartbeatRef.current as unknown as number);
        heartbeatRef.current = null;
      }
    }

    async function handleLostConnection(lostId: string) {
      try {
        const cur = await AsyncStorage.getItem(STORAGE_KEY);
        if (cur === lostId) await AsyncStorage.removeItem(STORAGE_KEY);
      } catch (e) {
        console.warn('remove persisted id on lost connection failed', e);
      }
      // clear connected id and notify user
      setConnectedId((prev) => (prev === lostId ? null : prev));
      Alert.alert('Disconnected', 'BLE connection was lost');
    }

    if (!connectedId) {
      stopHeartbeat();
      return;
    }

    // start heartbeat for the current connected id
    const deviceId = connectedId;
    heartbeatRef.current = setInterval(async () => {
      try {
        const ok = await isDeviceConnectedById(deviceId);
        if (!ok) {
          // lost connection
          stopHeartbeat();
          handleLostConnection(deviceId);
        }
      } catch (e) {
        // treat errors as disconnected
        stopHeartbeat();
        handleLostConnection(deviceId);
      }
    }, HEARTBEAT_INTERVAL_MS) as unknown as number;

    return () => stopHeartbeat();
  }, [connectedId]);

  async function requestPermissions() {
    // Platform-aware permission requests (Android & iOS)
    try {
      if (Platform.OS === 'android') {
        const scan = await request(PERMISSIONS.ANDROID.BLUETOOTH_SCAN);
        const connect = await request(PERMISSIONS.ANDROID.BLUETOOTH_CONNECT);
        const location = await request(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION);
        // Accept GRANTED for scan/connect, allow LIMITED for location
        const ok =
          (scan === RESULTS.GRANTED) &&
          (connect === RESULTS.GRANTED) &&
          (location === RESULTS.GRANTED || location === RESULTS.LIMITED);
        if (!ok) Alert.alert('Permissions required', 'Bluetooth permissions are required to scan for devices.');
        return ok;
      } else {
        // iOS: request bluetooth peripheral and location (if needed)
        const bt = PERMISSIONS.IOS?.BLUETOOTH_PERIPHERAL ? await request(PERMISSIONS.IOS.BLUETOOTH_PERIPHERAL) : RESULTS.GRANTED;
        const locPerm = PERMISSIONS.IOS?.LOCATION_WHEN_IN_USE ? await request(PERMISSIONS.IOS.LOCATION_WHEN_IN_USE) : RESULTS.GRANTED;
        const ok = (bt === RESULTS.GRANTED) && (locPerm === RESULTS.GRANTED || locPerm === RESULTS.LIMITED);
        if (!ok) Alert.alert('Permissions required', 'Bluetooth permissions are required to scan for devices.');
        return ok;
      }
    } catch (e) {
      console.warn('permission request failed', e);
      Alert.alert('Permissions error', 'Failed to request permissions');
      return false;
    }
  }

  async function startScan() {
    const ok = await requestPermissions();
    if (!ok) return;
    
    setDevices([]);
    setScanning(true);

    // use manager from ref and keep reference to subscription so we can remove it later
    const mgr = managerRef.current!;
    stateSubRef.current = mgr.onStateChange((state) => {
      if (state === 'PoweredOn') {
        // remove subscription since we only needed the state change to start scanning
        if (stateSubRef.current?.remove) stateSubRef.current.remove();
        stateSubRef.current = null;
        try {
          const serviceFilter = TARGET_SERVICE_UUID ? [TARGET_SERVICE_UUID] : null;
          mgr.startDeviceScan(serviceFilter, { allowDuplicates: false }, (error, device) => {
            if (error) {
              console.warn('Scan error', error);
              Alert.alert('Scan error', error.message ?? String(error));
              setScanning(false);
              return;
            }
            if (!device) return;
            // Replace existing device entry if present to pick up updated props
            setDevices((prev) => {
              const idx = prev.findIndex((d) => d.id === device.id);
              if (idx === -1) return [...prev, device];
              const copy = prev.slice();
              copy[idx] = device;
              return copy;
            });
          });
        } catch (e: any) {
          console.warn('startDeviceScan threw', e);
          Alert.alert('Scan failed', String(e?.message ?? e));
          setScanning(false);
        }
      }
    }, true);
  }

  function stopScan() {
    try {
      managerRef.current?.stopDeviceScan();
      if (stateSubRef.current?.remove) {
        stateSubRef.current.remove();
        stateSubRef.current = null;
      }
    } catch (e) {
      // ignore
    }
    setScanning(false);
  }

  async function connectToDevice(device: Device) {
    try {
      setConnectingId(device.id);
      // Stop scanning while connecting
      try {
        managerRef.current?.stopDeviceScan();
      } catch {}

      const connected = await managerRef.current!.connectToDevice(device.id);
      await connected.discoverAllServicesAndCharacteristics();
      ensureDeviceInList(connected);
      setConnectedId(device.id);
      // persist last connected id (JS-only)
      try {
        await AsyncStorage.setItem(STORAGE_KEY, device.id);
      } catch (e) {
        console.warn('persist connected id failed', e);
      }
      // initialize default inputs when connected
      setAngleInput('0');
      setTimeInput('1000');
      Alert.alert('Connected', `Connected to ${device.name ?? device.id}`);
    } catch (err: any) {
      console.warn('connect error', err);
      Alert.alert('Connection failed', String(err?.message ?? err));
    } finally {
      setConnectingId(null);
      setScanning(false);
    }
  }

  async function disconnectDevice(deviceId: string) {
    try {
      setConnectingId(deviceId);
      await managerRef.current!.cancelDeviceConnection(deviceId);
      setConnectedId((prev) => (prev === deviceId ? null : prev));
      // remove persisted id
      try {
        const cur = await AsyncStorage.getItem(STORAGE_KEY);
        if (cur === deviceId) await AsyncStorage.removeItem(STORAGE_KEY);
      } catch (e) {
        console.warn('remove persisted id failed', e);
      }
    } catch (err: any) {
      console.warn('disconnect error', err);
      Alert.alert('Disconnect failed', String(err?.message ?? err));
    } finally {
      setConnectingId(null);
    }
  }

  async function isDeviceConnectedById(deviceId: string) {
    try {
      return await managerRef.current!.isDeviceConnected(deviceId);
    } catch (e) {
      console.warn('isDeviceConnected error', e);
      return false;
    }
  }

  function ensureDeviceInList(device: Device) {
  setDevices((prev) => {
    if (prev.find((d) => d.id === device.id)) return prev;
    return [...prev, device];
  });
  }

  // Helper: encode Uint8Array to base64 (no external deps)
  function base64FromBytes(bytes: Uint8Array) {
    const lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bin = '';
    const len = bytes.length;
    let i;
    for (i = 0; i < len; i += 3) {
      const a = bytes[i];
      const b = i + 1 < len ? bytes[i + 1] : 0;
      const c = i + 2 < len ? bytes[i + 2] : 0;
      const triple = (a << 16) + (b << 8) + c;
      bin += lookup[(triple >> 18) & 0x3f];
      bin += lookup[(triple >> 12) & 0x3f];
      bin += i + 1 < len ? lookup[(triple >> 6) & 0x3f] : '=';
      bin += i + 2 < len ? lookup[triple & 0x3f] : '=';
    }
    return bin;
  }

  // Pack two 32-bit little-endian unsigned integers (angle, timeMs) and write to characteristic
  async function sendAngleTime(deviceId: string) {
    const angle = Number.parseInt(angleInput || '0', 10);
    const timeMs = Number.parseInt(timeInput || '0', 10);
    if (!Number.isFinite(angle) || !Number.isFinite(timeMs)) {
      Alert.alert('Invalid input', 'Angle and time must be numbers');
      return;
    }
    try {
      // create 8-byte buffer
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      dv.setUint32(0, angle >>> 0, true); // little-endian
      dv.setUint32(4, timeMs >>> 0, true);
      const bytes = new Uint8Array(buf);
      const b64 = base64FromBytes(bytes);

      await managerRef.current!.writeCharacteristicWithResponseForDevice(deviceId, TARGET_SERVICE_UUID, TARGET_CHARACTERISTIC_UUID, b64);
      Alert.alert('Write successful', `Wrote angle=${angle}, time=${timeMs}ms`);
    } catch (err: any) {
      console.warn('write error', err);
      Alert.alert('Write failed', String(err?.message ?? err));
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.content}>
        {connectedId ? null : (
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={() => (scanning ? stopScan() : startScan())}
          >
            <Text style={styles.buttonText}>{scanning ? 'Stop scan' : 'Start scan'}</Text>
          </Pressable>
        )}
        <FlatList
          data={devices}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => {
            const isConnecting = connectingId === item.id;
            const isConnected = connectedId === item.id;
            return (
              <Pressable
                onPress={() => (isConnected ? disconnectDevice(item.id) : connectToDevice(item))}
                style={styles.deviceRow}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <Text style={styles.deviceName}>{item.name ?? 'Unknown'}</Text>
                    <Text style={styles.deviceId}>{item.id}</Text>
                  </View>
                  <View style={{ alignItems: 'center' }}>
                    {isConnecting ? <ActivityIndicator /> : null}
                    {isConnected ? (
                      <Text style={{ color: 'green' }}>Connected</Text>
                    ) : (
                      <Text style={{ color: '#007AFF' }}>{isConnecting ? 'Connecting' : 'Connect'}</Text>
                    )}
                  </View>
                </View>
                {isConnected ? (
                  <View style={{ marginTop: 8 }}>
                    <View style={{ marginBottom: 8 }}>
                      <Text style={{ fontWeight: '600', marginBottom: 4 }}>Angle</Text>
                      <TextInput
                        value={angleInput}
                        onChangeText={setAngleInput}
                        keyboardType="numeric"
                        placeholder="0"
                        placeholderTextColor="#888"
                        style={[styles.input, { width: 120 }]}
                      />
                    </View>

                    <View style={{ marginBottom: 8 }}>
                      <Text style={{ fontWeight: '600', marginBottom: 4 }}>Time (ms)</Text>
                      <TextInput
                        value={timeInput}
                        onChangeText={setTimeInput}
                        keyboardType="numeric"
                        placeholder="1000"
                        placeholderTextColor="#888"
                        style={[styles.input, { width: 160 }]}
                      />
                    </View>

                    <Pressable
                      style={({ pressed }) => [styles.button, { marginTop: 8 }, pressed && styles.buttonPressed]}
                      onPress={() => sendAngleTime(item.id)}
                    >
                      <Text style={styles.buttonText}>Send</Text>
                    </Pressable>
                  </View>
                ) : null}
              </Pressable>
            );
          }}
          style={styles.list}
        />
        {!connectedId ? null : (
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={() => disconnectDevice(connectedId)}
          >
            <Text style={styles.buttonText}>Disconnect</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { flex: 1, padding: 16 },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: 'white', fontWeight: '600' },
  list: { flex: 1 },
  deviceRow: { padding: 10, borderBottomWidth: 1, borderBottomColor: '#eee' },
  deviceName: { fontSize: 16 },
  deviceId: { color: '#666', fontSize: 12 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 8,
    borderRadius: 6,
    backgroundColor: '#fff',
    color: '#000',
  },
});
