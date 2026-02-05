import type { Detection } from '@/modules/yoloUtils';

export type BallSide = 'left' | 'right' | 'center' | null;

const BALL_LABEL = 'sports ball';
const CENTER_THRESHOLD_RATIO = 0.05;

export const getBallSide = (detections: Detection[], frameWidth: number): BallSide => {
  if (frameWidth <= 0) {
    return null;
  }
  const sportsBall = detections.find((det) => (det.className ?? det.class) === BALL_LABEL);
  if (!sportsBall) {
    return null;
  }
  const centerX = sportsBall.x + sportsBall.width / 2;
  const frameCenter = frameWidth / 2;
  const delta = centerX - frameCenter;
  if (Math.abs(delta) <= frameWidth * CENTER_THRESHOLD_RATIO) {
    return 'center';
  }
  return delta < 0 ? 'left' : 'right';
};

/**
 * Calculate turn signal value for BLE transmission
 * 
 * Options:
 * 1. Simple discrete: -1 (left), 0 (center), +1 (right)
 * 2. Normalized offset: -1.0 to +1.0 (normalized distance from center)
 * 3. Percentage offset: -100 to +100 (percentage of frame width from center)
 * 
 * @param detections - Array of detections
 * @param frameWidth - Width of the frame
 * @param mode - Calculation mode: 'discrete', 'normalized', or 'percentage'
 * @returns Turn signal value, or null if no ball detected
 */
export const getTurnSignalValue = (
  detections: Detection[],
  frameWidth: number,
  mode: 'discrete' | 'normalized' | 'percentage' = 'normalized'
): number | null => {
  if (frameWidth <= 0) {
    return null;
  }
  
  const sportsBall = detections.find((det) => (det.className ?? det.class) === BALL_LABEL);
  if (!sportsBall) {
    return null;
  }
  
  const centerX = sportsBall.x + sportsBall.width / 2;
  const frameCenter = frameWidth / 2;
  const delta = centerX - frameCenter;
  const maxDelta = frameWidth / 2; // Maximum possible offset
  
  switch (mode) {
    case 'discrete':
      // Simple: -1 (left), 0 (center), +1 (right)
      if (Math.abs(delta) <= frameWidth * CENTER_THRESHOLD_RATIO) {
        return 0;
      }
      return delta < 0 ? -1 : 1;
      
    case 'normalized':
      // Normalized offset: -1.0 (far left) to +1.0 (far right)
      // Clamp to [-1, 1] range
      return Math.max(-1, Math.min(1, delta / maxDelta));
      
    case 'percentage':
      // Percentage offset: -100 (far left) to +100 (far right)
      // Clamp to [-100, 100] range
      return Math.max(-100, Math.min(100, (delta / maxDelta) * 100));
      
    default:
      return null;
  }
};
