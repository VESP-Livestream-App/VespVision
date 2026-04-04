/**
 * Control Loop Module
 * 
 * Main control loop that integrates camera detections with the controller
 * and servo to track a target (sports ball).
 * 
 * Translates the Python main() control loop to TypeScript.
 */

import { Servo } from './servoController';
import { PIDController } from './pidController';
import type { Detection } from './yoloUtils';

export interface ControlLoopConfig {
  fieldOfView?: number;        // Camera field of view in degrees (default: 70)
  servoSpeed?: number;          // Servo speed in degrees/second (default: 60)
  kp?: number;                  // Proportional gain (default: 25.0)
  ki?: number;                  // Integral gain (default: 0.1)
  kd?: number;                  // Derivative gain (default: 5.0)
  derivativeBufferSize?: number; // Samples for derivative smoothing (default: 3)
  frameWidth?: number;          // Camera frame width in pixels (default: 640)
  planeDegrees?: number;        // Total plane range in degrees (default: 180)
  edgeViewRedundancyFactor?: number; // Edge buffer factor (default: 0.25)
  searchModeDelayMs?: number;   // Delay before entering search mode when target is lost
}

export interface ControlLoopState {
  isTracking: boolean;          // True if target is currently visible
  isSearching: boolean;          // True if in search mode
  lastError: number | null;      // Last computed error in degrees
  normalizedError: number | null; // Last normalized error [-1, 1]
  controlSignal: number | null;  // Last control signal
  targetAngle: number | null;    // Current target angle for servo
  lastDetectedBallAngle: number | null; // Ball angle at the latest detection
}

export class ControlLoop {
  private readonly fieldOfView: number;
  private readonly frameWidth: number;
  private readonly planeDegrees: number;
  private readonly edgeRedundancyFactor: number;
  private readonly searchModeDelayMs: number;
  private readonly movementThreshold: number = 0.0;
  
  private readonly servo: Servo;
  private readonly controller: PIDController;
  
  private state: ControlLoopState = {
    isTracking: true,
    isSearching: false,
    lastError: null,
    normalizedError: null,
    controlSignal: null,
    targetAngle: null,
    lastDetectedBallAngle: null,
  };

  private lastControlTime: number = 0;
  private targetLostAt: number | null = null;

  constructor(config: ControlLoopConfig = {}) {
    const {
      fieldOfView = 70,
      servoSpeed = 40.0,
      kp = 0.40 * fieldOfView,
      ki = 0.03 * fieldOfView,
      kd = 0.08 * fieldOfView,
      derivativeBufferSize = 1,
      frameWidth = 640,
      planeDegrees = 180,
      edgeViewRedundancyFactor = 0.25,
      searchModeDelayMs = 1500,
    } = config;

    this.fieldOfView = fieldOfView;
    this.frameWidth = frameWidth;
    this.planeDegrees = planeDegrees;
    this.edgeRedundancyFactor = edgeViewRedundancyFactor;
    this.searchModeDelayMs = searchModeDelayMs;
    
    
    this.servo = new Servo({
      initialPos: 90.0,
      speed: servoSpeed,
      minPos: 0.0,
      maxPos: planeDegrees,
    });
    
    this.controller = new PIDController({ kp, ki, kd, derivativeBufferSize });
  }

  /**
   * Get current state
   */
  getState(): Readonly<ControlLoopState> {
    return { ...this.state };
  }

  /**
   * Convert pixel position to angle in degrees
   * Maps frame pixels (0 to frameWidth) to plane degrees (0 to planeDegrees)
   * 
   * @param pixelX - X position in pixels (center of detection)
   * @returns Angle in degrees
   */
  pixelToAngle(pixelX: number): number {
    // Map pixel position to angle
    // pixelX = 0 -> angle = 0
    // pixelX = frameWidth -> angle = planeDegrees
    const normalized = pixelX / this.frameWidth;
    return normalized * this.fieldOfView;
  }

  /**
   * Get visible window indices (for debugging/compatibility with Python)
   * 
   * @param servoPos - Current servo position in degrees
   * @returns Range of visible angles [min, max]
   */
  getVisibleWindow(servoPos: number): { min: number; max: number } {
    const halfFov = this.fieldOfView / 2;
    return {
      min: Math.max(0, servoPos - halfFov),
      max: Math.min(this.planeDegrees, servoPos + halfFov),
    };
  }

  /**
   * Update control loop with new detection
   * This is the main control function that should be called periodically
   * 
   * @param detections - Array of detections from YOLO
   * @param currentServoPos - Current servo position from BLE (degrees)
   * @param frameWidth - Current frame width (may differ from config)
   * @returns Control command: { angle, timeMs } or null if no update needed
   */
  update(
    detections: Detection[],
    currentServoPos: number,
    frameWidth?: number
  ): { angle: number; timeMs: number } | null {
    const now = Date.now();
    const elapsed = now - this.lastControlTime;
    
    this.lastControlTime = now;
    console.log(`\n🔄 [Control] Update cycle (${elapsed.toFixed(0)}ms since last)`);
    
    // Use provided frameWidth or fall back to config
    const effectiveFrameWidth = frameWidth ?? this.frameWidth;
    
    // Find sports ball detection (support multiple ball types)
    const BALL_LABELS = ['sports ball', 'basketball', 'soccer ball', 'tennis ball'];
    const ballDetection = detections.find(
      (det) => {
        const label = String(det.className ?? det.class).toLowerCase();
        // Use det.score if present, otherwise assume 1.0 (for backward compatibility)
        const score = (det as any)?.score ?? 1.0;
        return BALL_LABELS.includes(label) && score >= 0.7;
      }
    );
    
    // If no ball detected, enter search mode
    console.log(ballDetection, this.state.isTracking, this.state.isSearching);
    if (!ballDetection) {
      // Clear PID history while target is missing so stale integral/derivative
      // values do not cause jumps when detections resume.
      this.controller.reset();
      this.state.lastDetectedBallAngle = null;
      this.state.controlSignal = null;
      this.state.normalizedError = null;
      // Update servo search mode if needed - only when actually searching
      if (this.servo.isSearching) {
        const updated = this.servo.updateSearch(currentServoPos, this.fieldOfView, this.edgeRedundancyFactor);
        if (updated) {
          this.state.targetAngle = this.servo.targetPos;
          const timeMs = this.servo.getTimeToTarget(currentServoPos);
          console.log('🔍 [Control] Searching...');
          console.log(`   Current servo pos: ${currentServoPos.toFixed(2)}°`);
          console.log(`   Target angle: ${this.servo.targetPos.toFixed(2)}°`);
          console.log(`   Time to move: ${timeMs}ms`);
          return { angle: this.servo.targetPos, timeMs };
        }
      }
      
      else if (this.state.isTracking) {
        // Just lost target - wait before entering search mode
        if (this.targetLostAt === null) {
          this.targetLostAt = now;
        }
        const lostForMs = now - this.targetLostAt;
        if (lostForMs < this.searchModeDelayMs) {
          console.log(`⏳ [Control] Target lost - waiting ${this.searchModeDelayMs - lostForMs}ms before search mode`);
          return null;
        }

        console.log('🎯 [Control] Target lost - entering search mode');
        console.log(`   Current servo pos: ${currentServoPos.toFixed(2)}°`);
        this.state.isTracking = false;
        this.state.isSearching = true;
        
        // Determine search direction based on last error
        const searchDirection = (this.state.lastError ?? 0) < 0 ? 1 : -1;
        this.servo.searchTarget(searchDirection, this.fieldOfView, this.edgeRedundancyFactor);
        
        this.state.targetAngle = this.servo.targetPos;
        const timeMs = this.servo.getTimeToTarget(currentServoPos);
        
        console.log(`   Search direction: ${searchDirection > 0 ? 'left-to-right' : 'right-to-left'}`);
        console.log(`   Target angle: ${this.servo.targetPos.toFixed(2)}°`);
        console.log(`   Time to move: ${timeMs}ms`);
        
        return { angle: this.servo.targetPos, timeMs };
      }
      return null;
    }

    this.targetLostAt = null;
    
    // Ball detected - calculate position
    const ballCenterX = ballDetection.x + ballDetection.width / 2;
    const fovAngle = this.pixelToAngle(ballCenterX);
    const detectedBallAngle = currentServoPos - this.fieldOfView / 2 + fovAngle;
    this.state.lastDetectedBallAngle = detectedBallAngle;
    
    console.log('⚽ [Control] Ball detected');
    console.log(`   Ball center X: ${ballCenterX.toFixed(1)}px`);
    console.log(`   Target angle: ${detectedBallAngle.toFixed(2)}°`);
    console.log(`   Current servo pos: ${currentServoPos.toFixed(2)}°`);
    
    // Check if target is visible
    const visibleWindow = this.getVisibleWindow(currentServoPos);
    console.log(`   Visible window: [${visibleWindow.min.toFixed(2)}°, ${visibleWindow.max.toFixed(2)}°]`);
    
    // Target is visible - track it
    if (this.state.isSearching || !this.state.isTracking) {
      // Just found target - exit search mode
      console.log('✅ [Control] Target found - exiting search mode');
      this.state.isSearching = false;
      this.state.isTracking = true;
    }
    
    // Calculate error: distance from center of image
    // Center of image = currentServoPos - this.fieldOfView / 2
    // Target location = fovAngle
    // Error = Target - Center
    const errorDegrees = fovAngle - this.fieldOfView / 2;
    this.state.lastError = errorDegrees;
    
    // Normalize error to [-1.0, 1.0] range based on plane dimensions
    const normalizedError = errorDegrees / (this.fieldOfView / 2);
    this.state.normalizedError = normalizedError;
    
    // Compute control signal
    const controlSignal = this.controller.computeControl(normalizedError, true);
    this.state.controlSignal = controlSignal;
    
    // Calculate new servo target
    // New Angle = Current Angle + Correction
    // Scale control signal to degrees (gain scaler = 1.0)
    const displacement = controlSignal * 1.0;
    if (Math.abs(displacement) < this.movementThreshold) {
      console.log(`   Displacement (${displacement.toFixed(2)}°) below threshold (${this.movementThreshold}°) - skipping update`);
      return null;
    }
    const newServoTarget = currentServoPos + displacement;
    
    // Clamp to valid range
    const clampedTarget = Math.max(0, Math.min(180, newServoTarget));
    
    // Update servo target
    this.servo.moveTo(clampedTarget);
    this.state.targetAngle = clampedTarget;
    
    // Calculate time to move
    const timeMs = this.servo.getTimeToTarget(currentServoPos);
    
    console.log('📊 [Control] Tracking calculation:');
    console.log(`   Error: ${errorDegrees.toFixed(2)}°`);
    console.log(`   Normalized error: ${normalizedError.toFixed(3)}`);
    console.log(`   Control signal: ${controlSignal.toFixed(2)}`);
    console.log(`   Displacement: ${displacement.toFixed(2)}°`);
    console.log(`   New servo target: ${clampedTarget.toFixed(2)}°`);
    console.log(`   Time to move: ${timeMs}ms`);
    
    return { angle: clampedTarget, timeMs };
  }

  /**
   * Reset control loop state
   */
  reset(): void {
    this.state = {
      isTracking: false,
      isSearching: false,
      lastError: null,
      normalizedError: null,
      controlSignal: null,
      targetAngle: null,
      lastDetectedBallAngle: null,
    };
    this.lastControlTime = 0;
    this.targetLostAt = null;
    this.controller.reset();
    this.servo.moveTo(90.0);
  }
}
