/**
 * BLE Client Module
 * 
 * This is where your teammate should implement the BLE communication.
 * 
 * The turn signal data will be automatically passed here from the camera screen.
 * You just need to implement the sendTurnSignal function to transmit the data
 * to your microcontroller via BLE.
 */

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
let isWriting = false;

export const sendTurnSignal = async (
  value: number,
  hasBall: boolean
): Promise<void> => {
  if (isWriting) {
    // Drop this packet if we are already writing
    return;
  }
  
  isWriting = true;

  try {
    // Check if BLE service is connected
    const bleService = getBLEControlService();
    if (!bleService.isConnected()) {
      return;
    }
    
    // We would send the command here
    // await bleService.sendCommand(...)
    
  } catch (error) {
    console.error('BLE Write Error:', error);
  } finally {
    isWriting = false;
  }
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
