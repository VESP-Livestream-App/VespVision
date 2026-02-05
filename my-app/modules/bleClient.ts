/**
 * BLE Client Module
 * 
 * This is where your teammate should implement the BLE communication.
 * 
 * The turn signal data will be automatically passed here from the camera screen.
 * You just need to implement the sendTurnSignal function to transmit the data
 * to your microcontroller via BLE.
 */

import type { TurnSignalData } from './bleTurnSignal';

/**
 * Send turn signal data to microcontroller via BLE
 * 
 * @param value - Turn signal value: -1.0 (left) to +1.0 (right), or 0.0 (no ball)
 * @param hasBall - Whether a ball was detected (true) or not (false)
 * 
 * Example values:
 * - { value: -0.75, hasBall: true }  → Ball detected on left side
 * - { value: 0.0, hasBall: true }    → Ball detected at center
 * - { value: 0.50, hasBall: true }   → Ball detected on right side
 * - { value: 0.0, hasBall: false }   → No ball detected
 */
export const sendTurnSignal = async (
  value: number,
  hasBall: boolean
): Promise<void> => {
  // TODO: Implement BLE transmission here
  // 
  // Example implementation:
  // 1. Connect to BLE device (if not already connected)
  // 2. Write to characteristic with the turn signal data
  // 3. Format: You might want to send as bytes:
  //    - Byte 0: hasBall (0 or 1)
  //    - Byte 1-4: value as float32 (-1.0 to +1.0)
  //    Or send as a simple protocol:
  //    - Send two values: [hasBall ? 1 : 0, value]
  //
  // Example using react-native-ble-plx:
  // await device.writeCharacteristicWithoutResponseForService(
  //   SERVICE_UUID,
  //   CHARACTERISTIC_UUID,
  //   Buffer.from([hasBall ? 1 : 0, ...float32ToBytes(value)])
  // );
  
  console.log('📡 BLE: Sending turn signal', { value, hasBall });
  
  // Placeholder - replace with actual BLE code
  throw new Error('BLE sendTurnSignal not implemented yet');
};

/**
 * Optional: Helper to convert float to bytes if needed
 */
export const float32ToBytes = (value: number): Uint8Array => {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true); // little-endian
  return new Uint8Array(buffer);
};
