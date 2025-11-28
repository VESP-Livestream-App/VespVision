import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';

// Manager must be created outside the component lifecycle to persist across renders
const manager = new BleManager();

export default function App() {
  const [status, setStatus] = useState<string>('Initializing BLE...');
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);

  useEffect(() => {
    // 1. Wait for the phone's Bluetooth to fully power on
    const subscription = manager.onStateChange((state) => {
      if (state === 'PoweredOn') {
        scanAndConnect();
        subscription.remove();
      }
    }, true);

    return () => manager.destroy();
  }, []);

  const scanAndConnect = () => {
    setStatus('Scanning for devices...');
    
    // 2. Start scanning for any device (null allows all UUIDs)
    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.error(error);
        setStatus('Scan Error: ' + error.message);
        return;
      }

      const name = device?.name;
      const localName = device?.localName;
      
      // Optional: Log names to console so you can see what is actually being found
      // console.log(`Found: ${name} (Local: ${localName})`);

      // 3. Check for your custom name OR common Arduino library defaults
      if (
        name === 'bballtripod' || 
        localName === 'bballtripod' ||
        name === 'Nano 33 IoT' || 
        localName === 'Nano 33 IoT' ||
        name === 'Arduino' ||
        localName === 'Arduino'
      ) {
        // Stop scanning immediately to save battery and free up the radio for connection
        manager.stopDeviceScan();
        setStatus(`Found ${name || localName}! Connecting...`);
        connectToDevice(device);
      }
    });
  };

  const connectToDevice = async (device: Device) => {
    try {
      // 4. Connect to the device
      const connected = await device.connect();
      
      // 5. Discover Services (CRITICAL: You cannot read/write without this)
      await connected.discoverAllServicesAndCharacteristics();
      
      setConnectedDevice(connected);
      setStatus(`Connected to ${connected.name || 'Device'}`);
      console.log('Connected to ID:', connected.id);
      
    } catch (error: any) {
      console.error('Connection failed:', error);
      setStatus('Connection Failed: ' + error.message);
      
      // Optional: Retry scanning if connection fails
      // setTimeout(scanAndConnect, 2000);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.text}>{status}</Text>
      {connectedDevice && (
        <View style={styles.deviceInfo}>
          <Text style={styles.subText}>Connected Device:</Text>
          <Text style={styles.deviceName}>{connectedDevice.name}</Text>
          <Text style={styles.deviceId}>{connectedDevice.id}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    backgroundColor: '#fff',
    padding: 20
  },
  text: { 
    fontSize: 18, 
    fontWeight: 'bold', 
    textAlign: 'center',
    marginBottom: 20
  },
  deviceInfo: {
    alignItems: 'center',
    marginTop: 20,
    padding: 15,
    backgroundColor: '#f0f0f0',
    borderRadius: 10
  },
  subText: { 
    color: 'gray',
    marginBottom: 5
  },
  deviceName: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#007AFF'
  },
  deviceId: {
    fontSize: 12,
    color: '#333',
    marginTop: 5
  }
});