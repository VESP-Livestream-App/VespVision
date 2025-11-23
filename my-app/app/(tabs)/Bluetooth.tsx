import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Button } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx'; 
import { Base64 } from 'js-base64'; // Used to encode data before sending over BLE
// Removed: import { requestBLEPermissions, SERVICE_UUID, COMMAND_CHAR_UUID, NANO_NAME } from '../utils/blePermissions'; 
// npm install react-native-ble-plx js-base64
// --- START: Merged Constants and Permission Function ---

// Define the Service and Characteristic UUIDs used by your Arduino Nano 33 IoT.
// YOU MUST REPLACE THESE WITH THE ACTUAL UUIDS FROM YOUR ARDUINO SKETCH.
const SERVICE_UUID = "499d163b-be72-4691-a8af-61657909ac11"; 
const COMMAND_CHAR_UUID = "b793f920-016e-49ea-a4fd-15fe1d21a1a5";
const NANO_NAME = ""; // The name advertised by your Arduino

// For iOS, the system handles the permission prompt, so we just confirm readiness.
const requestBLEPermissions = async () => {
  return true; 
};

// --- END: Merged Constants and Permission Function ---


// Initialize the BleManager instance outside the component
const manager = new BleManager(); 

export default function BluetoothScreen() {
  const [isScanning, setIsScanning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [statusMessage, setStatusMessage] = useState("Checking BLE Status...");

  // --- Helper function for logging status ---
  const log = (message: string) => {
    console.log(`[BLE LOG]: ${message}`);
    setStatusMessage(message);
  };

  // --- Step 4: Sending Data to the Arduino ---
  const sendMotorCommand = async (command: string) => {
    if (!connectedDevice) {
        log("Error: Not connected. Cannot send command.");
        return;
    }

    try {
        // BLE requires data to be sent in Base64 format
        const encodedCommand = Base64.encode(command);

        await connectedDevice.writeCharacteristicWithResponseForService(
            SERVICE_UUID,
            COMMAND_CHAR_UUID,
            encodedCommand
        );
        log(`Sent command: ${command}`);

    } catch (error: any) {
        log(`Send Error: ${error.message}`);
        setConnectedDevice(null);
        setIsConnected(false);
    }
  };

  // --- Step 3: Connecting and Discovering Services ---
  const connectDevice = async (device: Device) => {
    manager.stopDeviceScan(); // Stop scan once found
    setIsScanning(false);
    log(`Connecting to ${device.name}...`);

    try {
        // 3a. Connect to the device
        const connected = await device.connect();
        
        // 3b. Discover services and characteristics (MANDATORY step)
        const fullDevice = await connected.discoverAllServicesAndCharacteristics();
        
        setConnectedDevice(fullDevice);
        setIsConnected(true);
        log(`Connected and services discovered! Ready for commands.`);

        // Optional: Monitor disconnection
        fullDevice.onDisconnected((error, device) => {
            log(`Device disconnected: ${device?.name}.`);
            setConnectedDevice(null);
            setIsConnected(false);
        });

    } catch (error: any) {
        log(`Connection Error: ${error.message}`);
    }
  };
  
  // --- Step 2: Scanning for the Device ---
  const startScan = () => {
    if (!manager) return;
    
    // Check BLE power state again before scanning
    manager.state().then(state => {
        if (state !== 'PoweredOn') {
            log(`Bluetooth is OFF. Current state: ${state}`);
            return;
        }
        
        log(`Starting scan for "${NANO_NAME}"...`);
        setIsScanning(true);
        
        // Start scanning, filtering by the Service UUID is optional but recommended
        manager.startDeviceScan(null, null, (error, device) => {
            if (error) {
                log(`Scan Error: ${error.message}`);
                setIsScanning(false);
                return;
            }

            // Filter by the advertised name
            if (device?.name === NANO_NAME || device?.localName === NANO_NAME) { 
                log(`Found target device: ${device.name}.`);
                connectDevice(device);
            }
        });
        
        // Stop scanning after a time limit to save battery
        setTimeout(() => {
            if (isScanning) {
                manager.stopDeviceScan();
                setIsScanning(false);
                log("Scan timed out.");
            }
        }, 15000); 
    });
  };

  // --- Step 1: Initial Setup and Permission Check ---
  useEffect(() => {
    const setupBLE = async () => {
        const permissionsGranted = await requestBLEPermissions();
        
        if (permissionsGranted) {
            // Monitor the Bluetooth radio's state
            const subscription = manager.onStateChange((state) => {
                if (state === 'PoweredOn') {
                    // Start scanning immediately after the radio powers on
                    startScan(); 
                    subscription.remove();
                } else if (state === 'PoweredOff') {
                    log("Bluetooth OFF. Please enable it.");
                }
            }, true); // The 'true' runs the initial check immediately

            return () => subscription.remove();
        } else {
            log("Permissions required to use Bluetooth.");
        }
    };
    
    setupBLE();

    // Cleanup: Destroy the BleManager instance when the component is removed
    return () => {
        manager.destroy();
    };
    
  }, []); // Run only once on mount


  return (
    <View style={styles.container}>
        <Text style={styles.header}>Arduino Nano 33 IoT Control</Text>
        <Text style={styles.status}>{statusMessage}</Text>
        
        {!isConnected && !isScanning && (
            <Button title="Start Scan" onPress={startScan} />
        )}

        {isScanning && (
            <Text style={styles.scanText}>Scanning... found {NANO_NAME}?</Text>
        )}

        {isConnected && (
            <View style={styles.controlContainer}>
                <Text style={styles.connectedText}>Connected to {connectedDevice?.name || 'Device'}</Text>
                <Button title="Send RIGHT Command" onPress={() => sendMotorCommand('RIGHT')} />
                <Button title="Send STOP Command" onPress={() => sendMotorCommand('STOP')} color="#841584" />
            </View>
        )}
    </View>
  );
}

const styles = StyleSheet.create({
    container: { flex: 1, paddingTop: 100, alignItems: 'center', backgroundColor: '#f0f0f0' },
    header: { fontSize: 24, fontWeight: 'bold', marginBottom: 30 },
    status: { fontSize: 16, marginVertical: 10, textAlign: 'center', color: '#555' },
    scanText: { fontSize: 16, color: 'orange', marginVertical: 10 },
    connectedText: { fontSize: 18, color: 'green', marginVertical: 10, fontWeight: 'bold' },
    controlContainer: { marginTop: 20, width: '80%', gap: 10 },
});