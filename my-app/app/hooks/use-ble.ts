import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { PERMISSIONS, request, RESULTS } from 'react-native-permissions';
import { base64FromBytes, base64ToBytes } from '../../lib/base64';

// Use lazy initialization or null for Web to prevent crashes
const bleManager = new BleManager();

const TARGET_SERVICE_UUID = '499d163b-be72-4691-a8af-61657909ac11';
const TARGET_CHARACTERISTIC_UUID = 'b793f920-016e-49ea-a4fd-15fe1d21a1a5';
const CURRENT_POS_UUID = 'd69abf56-23cb-4101-a496-f7f0869130ef';
const STORAGE_KEY = 'ble.connectedId';

export default function useBle() {
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const connectedIdRef = useRef<string | null>(null);
  useEffect(() => { connectedIdRef.current = connectedId; }, [connectedId]);

  const [currentPos, setCurrentPos] = useState<number | null>(null);
  const [currentPosLoading, setCurrentPosLoading] = useState(false);

  const currentPosRef = useRef<number | null>(null);
  useEffect(() => { currentPosRef.current = currentPos; }, [currentPos]);

  const stateSubRef = useRef<any>(null);
  const charSubRef = useRef<any>(null);
  const posPollRef = useRef<number | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const HEARTBEAT_INTERVAL_MS = 2000;

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const mgr = bleManager;
        const connected = await mgr.connectedDevices(TARGET_SERVICE_UUID ? [TARGET_SERVICE_UUID] : []);
        if (!mounted) return;
        if (connected && connected.length > 0) {
          ensureDeviceInList(connected[0]);
          setConnectedId(connected[0].id);
          try { startCurrentPosMonitor(connected[0].id); } catch (e) { /* ignore */ }
        }
        try {
          const stored = await AsyncStorage.getItem(STORAGE_KEY);
          if (!mounted) return;
          if (stored && !connected.find((d) => d.id === stored)) {
            try {
              const reopened = await mgr.connectToDevice(stored);
              await reopened.discoverAllServicesAndCharacteristics();
              if (!mounted) return;
              setDevices((prev) => (prev.find((p) => p.id === reopened.id) ? prev : [...prev, reopened]));
              ensureDeviceInList(reopened);
              setConnectedId(reopened.id);
              try { startCurrentPosMonitor(reopened.id); } catch (e) { /* ignore */ }
            } catch (err) {
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
        bleManager.stopDeviceScan();
        if (stateSubRef.current?.remove) stateSubRef.current.remove();
        if (charSubRef.current?.remove) charSubRef.current.remove();
        if (posPollRef.current != null) {
          clearInterval(posPollRef.current as unknown as number);
          posPollRef.current = null;
        }
        if (heartbeatRef.current != null) {
          clearInterval(heartbeatRef.current as unknown as number);
          heartbeatRef.current = null;
        }
        // bleManager is global, do not destroy
      } catch (e) {
        // ignore
      }
    };
  }, []);

  // Heartbeat
  useEffect(() => {
    function stopHeartbeat() {
      if (heartbeatRef.current != null) {
        clearInterval(heartbeatRef.current as unknown as number);
        heartbeatRef.current = null;
      }
    }
    async function handleLostConnection(lostId: string) {
      try {
        // stop any monitors/polling and reset UI state
        try { stopCurrentPosMonitor(); } catch (e) { /* ignore */ }
        const cur = await AsyncStorage.getItem(STORAGE_KEY);
        if (cur === lostId) await AsyncStorage.removeItem(STORAGE_KEY);
      } catch (e) { console.warn('remove persisted id on lost connection failed', e); }
      setConnectedId((prev) => (prev === lostId ? null : prev));
      Alert.alert('Disconnected', 'BLE connection was lost');
    }
    if (!connectedId) { stopHeartbeat(); return; }
    const deviceId = connectedId;
    heartbeatRef.current = setInterval(async () => {
      try {
        const ok = await isDeviceConnectedById(deviceId);
        if (!ok) { stopHeartbeat(); handleLostConnection(deviceId); }
      } catch (e) { stopHeartbeat(); handleLostConnection(deviceId); }
    }, HEARTBEAT_INTERVAL_MS) as unknown as number;
    return () => stopHeartbeat();
  }, [connectedId]);

  async function requestPermissions() {
    try {
      if (Platform.OS === 'android') {
        const scan = await request(PERMISSIONS.ANDROID.BLUETOOTH_SCAN);
        const connect = await request(PERMISSIONS.ANDROID.BLUETOOTH_CONNECT);
        const location = await request(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION);
        const ok = (scan === RESULTS.GRANTED) && (connect === RESULTS.GRANTED) && (location === RESULTS.GRANTED || location === RESULTS.LIMITED);
        if (!ok) Alert.alert('Permissions required', 'Bluetooth permissions are required to scan for devices.');
        return ok;
      } else {
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
    console.log('startScan called');
    const ok = await requestPermissions();
    if (!ok) { console.log('startScan: perms denied'); return; }
    
    // Reset devices
    setDevices([]);
    setScanning(true);
    
    const mgr = bleManager;
    
    // Ensure any previous scan is stopped before starting a new one
    try { mgr.stopDeviceScan(); } catch (e) {}
    if (stateSubRef.current?.remove) { stateSubRef.current.remove(); stateSubRef.current = null; }

    const performScan = () => {
       console.log('startScan: starting device scan');
       try {
          const serviceFilter = TARGET_SERVICE_UUID ? [TARGET_SERVICE_UUID] : null;
          mgr.startDeviceScan(serviceFilter, { allowDuplicates: false }, (error, device) => {
            if (error) { 
               console.warn('Scan callback error', error); 
               // Only alert if we are supposed to be scanning
               setScanning((s) => {
                 if (s) Alert.alert('Scan error', error.message ?? String(error)); 
                 return false;
               });
               return; 
            }
            if (device) {
               // console.log('scanned device:', device.id, device.name);
               setDevices((prev) => {
                 const idx = prev.findIndex((d) => d.id === device.id);
                 if (idx === -1) return [...prev, device];
                 const copy = prev.slice(); copy[idx] = device; return copy;
               });
            }
          });
       } catch (e: any) { 
          console.warn('startDeviceScan threw', e); 
          Alert.alert('Scan failed', String(e?.message ?? e)); 
          setScanning(false); 
       }
    };

    const state = await mgr.state();
    console.log('startScan: current BLE state', state);
    if (state === 'PoweredOn') {
      performScan();
    } else {
      console.log('startScan: waiting for PoweredOn');
      const sub = mgr.onStateChange((s) => {
        console.log('startScan: state changed to', s);
        if (s === 'PoweredOn') {
          sub.remove();
          stateSubRef.current = null;
          performScan();
        }
      }, true);
      stateSubRef.current = sub;
    }
  }

  function stopScan() {
    try { bleManager.stopDeviceScan(); if (stateSubRef.current?.remove) { stateSubRef.current.remove(); stateSubRef.current = null; } } catch (e) { }
    setScanning(false);
  }

  async function connectToDevice(device: Device) {
    try {
      setConnectingId(device.id);
      try { bleManager.stopDeviceScan(); } catch {}
      const connected = await bleManager.connectToDevice(device.id);
      await connected.discoverAllServicesAndCharacteristics();
      setCurrentPosLoading(true);
      try {
        const ch = await bleManager.readCharacteristicForDevice(device.id, TARGET_SERVICE_UUID, CURRENT_POS_UUID);
        if (ch?.value) {
          const bytes = base64ToBytes(ch.value);
          if (bytes.length >= 4) {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const val = dv.getUint32(0, true);
            setCurrentPos(val);
            setCurrentPosLoading(false);
          }
        }
      } catch (e) { console.warn('initial readCharacteristicForDevice failed', e); }
      ensureDeviceInList(connected);
      setConnectedId(device.id);
      try {
        startCurrentPosMonitor(device.id); 
      } catch (e) { console.warn('startCurrentPosMonitor failed warning', e); }
      try { await AsyncStorage.setItem(STORAGE_KEY, device.id); } catch (e) { console.warn('persist connected id failed', e); }
      Alert.alert('Connected', `Connected to ${device.name ?? device.id}`);
    } catch (err: any) { console.warn('connect error', err); Alert.alert('Connection failed', String(err?.message ?? err)); }
    finally { setConnectingId(null); setScanning(false); }
  }

  async function disconnectDevice(deviceId: string) {
    setConnectingId(deviceId);
    try {
      await bleManager.cancelDeviceConnection(deviceId);
      setConnectedId((prev) => (prev === deviceId ? null : prev));
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
      // always stop monitoring/polling and reset UI state
      try { stopCurrentPosMonitor(); } catch (e) { /* ignore */ }
      setConnectingId(null);
    }
  }

  async function isDeviceConnectedById(deviceId: string) {
    try { return await bleManager.isDeviceConnected(deviceId); } catch (e) { console.warn('isDeviceConnected error', e); return false; }
  }

  function ensureDeviceInList(device: Device) {
    setDevices((prev) => (prev.find((d) => d.id === device.id) ? prev : [...prev, device]));
  }

  const sendAngleTime = useCallback(async (deviceId: string, angle: number, timeMs: number) => {
    if (!Number.isFinite(angle) || !Number.isFinite(timeMs)) { 
      console.warn('Invalid input', 'Angle and time must be numbers'); 
      return; 
    }
    const pos = currentPosRef.current;
    if (pos === null) {
      console.warn('Current position unknown', 'Cannot send command because current position is unknown');
      return;
    }
    try {
      const deltaAngle = angle - pos;
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      dv.setUint32(0, deltaAngle >>> 0, true);
      dv.setUint32(4, timeMs >>> 0, true);
      const bytes = new Uint8Array(buf);
      const b64 = base64FromBytes(bytes);
      await bleManager.writeCharacteristicWithResponseForDevice(deviceId, TARGET_SERVICE_UUID, TARGET_CHARACTERISTIC_UUID, b64);
    } catch (err: any) { console.warn('write error', err); }
  }, []);

  function startPosPolling(deviceId: string) {
    if (posPollRef.current != null) return;
    setCurrentPosLoading(true);
    posPollRef.current = setInterval(async () => {
      // Use ref to check connection status to avoid stale closure issues
      const currentConnectedId = connectedIdRef.current;
      
      // if we're no longer connected to this device, stop polling
      if (!currentConnectedId || currentConnectedId !== deviceId) {
        if (posPollRef.current != null) {
          clearInterval(posPollRef.current as unknown as number);
          posPollRef.current = null;
        }
        setCurrentPosLoading(false);
        return;
      }

      try {
        const ch = await bleManager.readCharacteristicForDevice(deviceId, TARGET_SERVICE_UUID, CURRENT_POS_UUID);
        if (ch?.value) {
          const bytes = base64ToBytes(ch.value);
          if (bytes.length >= 4) {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const val = dv.getUint32(0, true);
            setCurrentPos(val);
            setCurrentPosLoading(false);
          }
        }
      } catch (e) {
        try { console.warn('pos polling read failed (full):', JSON.stringify(e, Object.getOwnPropertyNames(e))); } catch (j) { console.warn('pos polling read failed', e); }
        console.warn('pos polling read failed.reason', e?.reason, 'errorCode', e?.errorCode, 'description', e?.description);
        // stop polling to avoid repeated native errors after disconnect
        if (posPollRef.current != null) {
          clearInterval(posPollRef.current as unknown as number);
          posPollRef.current = null;
        }
        setCurrentPosLoading(false);
      }
    }, 1000) as unknown as number;
  }

  function stopCurrentPosMonitor() {
    try { 
      if (charSubRef.current) {
        // Prevent double removal or null pointer issues
        const sub = charSubRef.current;
        charSubRef.current = null;
        if (sub.remove) sub.remove(); 
      }
    } catch (e) { 
      console.warn('stopCurrentPosMonitor remove failed', e);
    }
    if (posPollRef.current != null) { clearInterval(posPollRef.current as unknown as number); posPollRef.current = null; }
    setCurrentPos(null);
    setCurrentPosLoading(false);
  }

  function startCurrentPosMonitor(deviceId: string) {
    stopCurrentPosMonitor();
    // Switch to polling directly to effectively avoid the Native NullPointerException crash
    // caused by monitorCharacteristicForDevice on some Android devices/versions.
    console.log('startCurrentPosMonitor: defaulting to polling for stability');
    startPosPolling(deviceId);

    /*
    try {
      setCurrentPosLoading(true);
      charSubRef.current = bleManager.monitorCharacteristicForDevice(deviceId, TARGET_SERVICE_UUID, CURRENT_POS_UUID, (error, characteristic) => {
        if (error) { try { console.warn('monitor characteristic error (full):', JSON.stringify(error, Object.getOwnPropertyNames(error))); } catch (j) { console.warn('monitor characteristic error', error); } console.warn('monitor error.reason', error?.reason, 'errorCode', error?.errorCode, 'description', error?.description); startPosPolling(deviceId); return; }
        if (!characteristic?.value) return;
        const bytes = base64ToBytes(characteristic.value);
        if (bytes.length >= 4) { const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const val = dv.getUint32(0, true); setCurrentPos(val); setCurrentPosLoading(false); }
      });
    } catch (e) { console.warn('startCurrentPosMonitor threw', e); startPosPolling(deviceId); }
    */
  }

  return {
    devices,
    scanning,
    startScan,
    stopScan,
    connectToDevice,
    disconnectDevice,
    sendAngleTime,
    connectingId,
    connectedId,
    currentPos,
    currentPosLoading,
  };
}
