import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';

// Manager must be created outside the component lifecycle
const manager = new BleManager();

export default function App() {
  const [status, setStatus] = useState<string>('Initializing BLE...');
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);

  useEffect(() => {
    // 1. Wait for Bluetooth to power on
    const subscription = manager.onStateChange((state) => {
      if (state === 'PoweredOn') {
        scanAndConnect();
        subscription.remove();
      }
    }, true);

    return () => manager.destroy();
  }, []);

  const scanAndConnect = () => {
    setStatus('Scanning for bballtripod...');
    
    // 2. Start scanning
    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.error(error);
        setStatus('Scan Error: ' + error.message);
        return;
      }

      // 3. Check BOTH name properties for "bballtripod"
      const deviceName = device?.name;
      const localName = device?.localName;

      if (deviceName === 'BBallTripod' || localName === 'BBallTripod') {
        // Stop scanning immediately when found
        manager.stopDeviceScan();
        setStatus('bballtripod found! Connecting...');
        connectToDevice(device);
      }
    });
  };

  const connectToDevice = async (device: Device) => {
    try {
      // 4. Connect
      const connected = await device.connect();
      
      // 5. Discover Services (Required step)
      await connected.discoverAllServicesAndCharacteristics();
      
      setConnectedDevice(connected);
      setStatus('Successfully Connected to bballtripod!');
      console.log('Connected to:', connected.id);
      
    } catch (error) {
      console.error('Connection failed:', error);
      setStatus('Connection Failed');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.text}>{status}</Text>
      {connectedDevice && (
        <Text style={styles.subText}>Device ID: {connectedDevice.id}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    backgroundColor: '#fff' 
  },
  text: { 
    fontSize: 18, 
    fontWeight: 'bold', 
    textAlign: 'center',
    marginHorizontal: 20
  },
  subText: { 
    marginTop: 10, 
    color: 'gray' 
  },
});