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
import { getBLEControlService } from './bleControlService';

/**
 * Send turn signal data to microcontroller via BLE
 * 
 * Note: This is a legacy turn signal system. The control loop (controlLoop.ts)
 * is the primary system for servo control and uses sendAngleTime directly.
 * This function is kept for backward compatibility but may not be actively used.
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
  console.log('📡 BLE: Sending turn signal', { value, hasBall });
  
  // Check if BLE service is connected
  const bleService = getBLEControlService();
  if (!bleService.isConnected()) {
    console.warn('⚠️ BLE: No device connected, skipping turn signal');
    return;
  }

  // For now, this is a no-op since the control loop handles servo commands
  // If you need to implement a separate turn signal protocol, you can:
  // 1. Add a sendTurnSignal method to BLEControlService
  // 2. Use the BLE hook's sendAngleTime with converted values
  // 3. Implement a custom BLE characteristic write here
  
  // Example: Convert turn signal to angle command (if needed)
  // const centerAngle = 90; // Center position
  // const maxOffset = 45; // Max offset from center
  // const targetAngle = centerAngle + (value * maxOffset);
  // await bleService.sendCommand({ angle: targetAngle, timeMs: 100 });
  
  console.log('✅ BLE: Turn signal logged (control loop handles actual servo commands)');
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
