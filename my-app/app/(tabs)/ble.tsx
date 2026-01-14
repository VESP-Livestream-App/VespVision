import React, { useState } from 'react';
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
import useBle from '../hooks/use-ble';

export default function BleScreen() {
  const [angleInput, setAngleInput] = useState('0');
  const [timeInput, setTimeInput] = useState('1000');

  const {
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
  } = useBle();

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
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                      <Text style={{ marginRight: 8 }}>Current position:</Text>
                      {currentPosLoading ? (
                        <ActivityIndicator size="small" />
                      ) : currentPos != null ? (
                        <Text>{String(currentPos)}</Text>
                      ) : (
                        <Text style={{ color: '#888' }}>Waiting…</Text>
                      )}
                    </View>

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
                      onPress={() => sendAngleTime(item.id, Number(angleInput), Number(timeInput))}
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

        {/* Dedicated current position panel below other elements */}
        <View style={{ marginTop: 12, padding: 12, borderWidth: 1, borderColor: '#eee', borderRadius: 8, backgroundColor: '#fff' }}>
          <Text style={{ fontWeight: '600', marginBottom: 6 }}>Servo current position</Text>
          {currentPosLoading ? (
            <ActivityIndicator />
          ) : currentPos != null ? (
            <Text style={{ fontSize: 18 }}>{String(currentPos)}</Text>
          ) : (
            <Text style={{ color: '#888' }}>Waiting…</Text>
          )}
        </View>
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

