import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Button } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx'; 
import { Base64 } from 'js-base64'; 

// --- START: Merged Constants and Permission Function ---

const SERVICE_UUID = "499d163b-be72-4691-a8af-61657909ac11"; 
const COMMAND_CHAR_UUID = "b793f920-016e-49ea-a4fd-15fe1d21a1a5";
const NANO_NAME = "BBallTripod"; // The name advertised by your Arduino

const requestBLEPermissions = async () => {
  return true; 
};

// --- END: Merged Constants and Permission Function ---

const manager = new BleManager(); 

export default function BluetoothScreen() {
  const [isScanning, setIsScanning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [statusMessage, setStatusMessage] = useState("Checking BLE Status...");
  const [bleState, setBleState] = useState('Unknown'); // New: Track radio state

  const log = (message: string) => {
    console.log(`[BLE LOG]: ${message}`);
    setStatusMessage(message);
  };

  const sendMotorCommand = async (command: string) => {
    if (!connectedDevice) {
        log("Error: Not connected. Cannot send command.");
        return;
    }
    try {
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

  const connectDevice = async (device: Device) => {
    manager.stopDeviceScan(); 
    setIsScanning(false);
    log(`Connecting to ${device.name}...`);

    try {
        const connected = await device.connect();
        const fullDevice = await connected.discoverAllServicesAndCharacteristics();
        
        setConnectedDevice(fullDevice);
        setIsConnected(true);
        log(`Connected! Ready for commands.`);

        fullDevice.onDisconnected((error, device) => {
            log(`Device disconnected: ${device?.name}.`);
            setConnectedDevice(null);
            setIsConnected(false);
        });
    } catch (error: any) {
        log(`Connection Error: ${error.message}`);
    }
  };
  
  // --- FIXED: Removed the blocking state check ---
  const startScan = () => {
    if (!manager) return;
    if (isScanning) return;

    log(`Starting scan for "${NANO_NAME}"...`);
    setIsScanning(true);
    
    // We go straight to scanning. If the radio is off, this method 
    // will throw an error which we catch in the 'if (error)' block.
    manager.startDeviceScan(null, null, (error, device) => {
        if (error) {
            log(`Scan Error: ${error.message}`);
            setIsScanning(false);
            // Don't stop scanning here, just let the UI reflect the error
            return;
        }

        if (device?.name === NANO_NAME || device?.localName === NANO_NAME) { 
            log(`Found target device: ${device.name}.`);
            connectDevice(device);
        }
    });
    
    setTimeout(() => {
        if (isScanning) { 
            manager.stopDeviceScan();
            setIsScanning(false);
            log("Scan timed out.");
        }
    }, 15000); 
  };

  useEffect(() => {
    const setupBLE = async () => {
        const permissionsGranted = await requestBLEPermissions();
        
        if (permissionsGranted) {
            const subscription = manager.onStateChange((state) => {
                setBleState(state); // Update state for UI logic
                if (state === 'PoweredOn') {
                    log("Bluetooth is ON. Ready.");
                } else {
                    log(`Bluetooth State: ${state}`);
                }
            }, true);

            return () => subscription.remove();
        } else {
            log("Permissions denied.");
        }
    };
    
    setupBLE();

    return () => {
        manager.destroy();
    };
  }, []); 

  return (
    <View style={styles.container}>
        <Text style={styles.header}>Arduino Nano 33 IoT</Text>
        <Text style={styles.status}>{statusMessage}</Text>
        
        {/* Only show Start Scan button if we are NOT connected, NOT scanning, and BLE is ON */}
        {!isConnected && !isScanning && bleState === 'PoweredOn' && (
            <Button title="Start Scan" onPress={startScan} />
        )}

        {/* Show waiting message if BLE is not ready */}
        {!isConnected && bleState !== 'PoweredOn' && (
             <Text style={styles.scanText}>Waiting for Bluetooth...</Text>
        )}

        {isScanning && (
            <Text style={styles.scanText}>Scanning... found {NANO_NAME}?</Text>
        )}

        {isConnected && (
            <View style={styles.controlContainer}>
                <Text style={styles.connectedText}>Connected to {connectedDevice?.name || 'Device'}</Text>
                <Button title="Send RIGHT" onPress={() => sendMotorCommand('RIGHT')} />
                <Button title="Send LEFT" onPress={() => sendMotorCommand('LEFT')} />
                <Button title="STOP" onPress={() => sendMotorCommand('STOP')} color="#841584" />
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