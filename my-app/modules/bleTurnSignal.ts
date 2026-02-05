import type { Detection } from '@/modules/yoloUtils';
import { getTurnSignalValue } from '@/modules/ballDirection';

// Simple in-memory state to avoid spamming BLE with duplicate values
let lastSentValue: number | null = null;
let lastSentHasBall: boolean | null = null;

export type TurnSignalData = {
  value: number;    // -1.0 to +1.0 (ball position) or 0.0 (no ball)
  hasBall: boolean;  // true = ball detected, false = no ball detected
};

/**
 * Get turn signal data to send via BLE.
 * 
 * Returns:
 * - { value: -1.0 to +1.0, hasBall: true } when ball is detected
 * - { value: 0.0, hasBall: false } when no ball is detected
 * - null if no update needed (value hasn't changed)
 * 
 * @param detections - Array of detections from YOLO
 * @param frameWidth - Width of the camera frame
 * @returns Turn signal data or null if no update needed
 */
export const getTurnSignalForBLE = (
  detections: Detection[],
  frameWidth: number
): TurnSignalData | null => {
  if (frameWidth <= 0) {
    return null;
  }

  const turnSignal = getTurnSignalValue(detections, frameWidth, 'normalized');

  if (turnSignal === null) {
    // No ball detected
    const hasBall = false;
    const value = 0.0;
    
    // Only send if state changed (avoid spamming BLE)
    if (lastSentHasBall !== hasBall) {
      lastSentHasBall = hasBall;
      lastSentValue = value;
      return { value, hasBall };
    }
    return null; // Already sent "no ball" signal
  }

  // Ball detected
  const hasBall = true;
  const value = turnSignal;

  // Only send if value or detection state changed (avoid spamming BLE)
  if (lastSentValue === null || 
      lastSentHasBall !== hasBall || 
      value !== lastSentValue) {
    lastSentValue = value;
    lastSentHasBall = hasBall;
    return { value, hasBall };
  }

  return null; // No change, don't send
};

