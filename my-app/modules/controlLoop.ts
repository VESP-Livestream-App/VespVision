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
  missesBeforeSearch?: number;  // Consecutive empty detections required before search mode
  searchStepDegrees?: number;   // Search sweep step in degrees
  searchArrivalThresholdDegrees?: number; // How close to target before issuing next search step
  minDetectionWidthPx?: number; // Reject tiny detections below this width
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
  private fieldOfView: number;
  private readonly frameWidth: number;
  private readonly planeDegrees: number;
  private readonly edgeRedundancyFactor: number;
  private readonly searchModeDelayMs: number;
  private readonly missesBeforeSearch: number;
  private readonly searchStepDegrees: number;
  private readonly searchArrivalThresholdDegrees: number;
  private readonly minDetectionWidthPx: number;
  
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
  private consecutiveMisses: number = 0;
  private searchDirection: 1 | -1 = 1;
  private lastValidRadial: {
    r: number;
    worldAngleDeg: number;
    targetFovAngleDeg: number;
    servoPosDeg: number;
    tsMs: number;
  } | null = null;

  constructor(config: ControlLoopConfig = {}) {
    const {
      fieldOfView = 70, // Updated later if we receive data from the phone.
      servoSpeed = 40.0,
      kp = 0.35 * fieldOfView,
      ki = 0.03 * fieldOfView,
      kd = 0.05 * fieldOfView,
      derivativeBufferSize = 1,
      frameWidth = 640,
      planeDegrees = 180,
      edgeViewRedundancyFactor = 0.25,
      searchModeDelayMs = 1500,
      missesBeforeSearch = 15,
      searchStepDegrees = Math.max(8, Math.min(25, fieldOfView * 0.35)),
      searchArrivalThresholdDegrees = 4,
      minDetectionWidthPx = 24,
    } = config;

    this.fieldOfView = fieldOfView;
    this.frameWidth = frameWidth;
    this.planeDegrees = planeDegrees;
    this.edgeRedundancyFactor = edgeViewRedundancyFactor;
    this.searchModeDelayMs = searchModeDelayMs;
    this.missesBeforeSearch = Math.max(1, Math.floor(missesBeforeSearch));
    this.searchStepDegrees = Math.max(1, searchStepDegrees);
    this.searchArrivalThresholdDegrees = Math.max(0.5, searchArrivalThresholdDegrees);
    this.minDetectionWidthPx = Math.max(1, minDetectionWidthPx);
    
    
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
   * Maps frame pixels (0 to frameWidth) to plane degrees (0 to fieldOfView)
   * 
   * @param pixelX - X position in pixels (center of detection)
   * @returns Angle in degrees
   */
  pixelToAngle(pixelX: number, frameWidth: number = this.frameWidth): number {
    // Map pixel position to angle
    // pixelX = 0 -> angle = 0
    // pixelX = frameWidth -> angle = planeDegrees
    const safeFrameWidth = frameWidth > 0 ? frameWidth : this.frameWidth;
    const normalized = pixelX / safeFrameWidth;
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
    frameWidth?: number,
    fieldOfView?: number
  ): { angle: number; timeMs: number } | null {
    const now = Date.now();
    this.lastControlTime = now;
    
    // Use provided frameWidth or fall back to config
    const effectiveFrameWidth = frameWidth ?? this.frameWidth;
    if (typeof fieldOfView === 'number' && Number.isFinite(fieldOfView) && fieldOfView > 0) {
      this.fieldOfView = fieldOfView;
    }
    
    const ballCandidate = this.selectBestBallCandidate(
      detections,
      currentServoPos,
      effectiveFrameWidth,
      now
    );
    const ballDetection = ballCandidate?.det ?? null;
    if (!ballDetection) {
      console.log('⚪ [Control] No ball detected');
      this.consecutiveMisses += 1;
      // Clear PID history while target is missing so stale integral/derivative
      // values do not cause jumps when detections resume.
      this.controller.reset();
      this.state.lastDetectedBallAngle = null;
      this.state.controlSignal = null;
      this.state.normalizedError = null;
      // Update servo search mode if needed - only when actually searching
      if (this.servo.isSearching) {
        const distanceToCurrentTarget = Math.abs(currentServoPos - this.servo.targetPos);
        if (distanceToCurrentTarget > this.searchArrivalThresholdDegrees) {
          return null;
        }

        let nextTarget = currentServoPos + this.searchDirection * this.searchStepDegrees;
        if (nextTarget <= 0 || nextTarget >= this.planeDegrees) {
          this.searchDirection = (this.searchDirection === 1 ? -1 : 1);
          nextTarget = currentServoPos + this.searchDirection * this.searchStepDegrees;
        }
        const clampedTarget = Math.max(0, Math.min(this.planeDegrees, nextTarget));
        this.servo.setSearchTarget(clampedTarget);
        this.state.targetAngle = this.servo.targetPos;
        const timeMs = this.servo.getTimeToTarget(currentServoPos);
        console.log('🔍 [Control] Searching...');
        console.log(`   Current servo pos: ${currentServoPos.toFixed(2)}°`);
        console.log(`   Search direction: ${this.searchDirection > 0 ? 'left-to-right' : 'right-to-left'}`);
        console.log(`   Target angle: ${this.servo.targetPos.toFixed(2)}°`);
        console.log(`   Time to move: ${timeMs}ms`);
        return { angle: this.servo.targetPos, timeMs };
      }
      
      else if (this.state.isTracking) {
        // Just lost target - wait before entering search mode
        if (this.targetLostAt === null) {
          this.targetLostAt = now;
        }
        if (this.consecutiveMisses < this.missesBeforeSearch) {
          return null;
        }
        const lostForMs = now - this.targetLostAt;
        if (lostForMs < this.searchModeDelayMs) {
          return null;
        }

        console.log('🎯 [Control] Target lost - entering search mode');
        console.log(`   Current servo pos: ${currentServoPos.toFixed(2)}°`);
        this.state.isTracking = false;
        this.state.isSearching = true;
        this.lastValidRadial = null;
        
        // Determine search direction based on last error
        this.searchDirection = (this.state.lastError ?? 0) < 0 ? 1 : -1;
        let nextTarget = currentServoPos + this.searchDirection * this.searchStepDegrees;
        if (nextTarget <= 0 || nextTarget >= this.planeDegrees) {
          this.searchDirection = (this.searchDirection === 1 ? -1 : 1);
          nextTarget = currentServoPos + this.searchDirection * this.searchStepDegrees;
        }
        this.servo.setSearchTarget(Math.max(0, Math.min(this.planeDegrees, nextTarget)));
        
        this.state.targetAngle = this.servo.targetPos;
        const timeMs = this.servo.getTimeToTarget(currentServoPos);
        
        console.log(`   Search direction: ${this.searchDirection > 0 ? 'left-to-right' : 'right-to-left'}`);
        console.log(`   Target angle: ${this.servo.targetPos.toFixed(2)}°`);
        console.log(`   Time to move: ${timeMs}ms`);
        
        return { angle: this.servo.targetPos, timeMs };
      }
      return null;
    }

    this.consecutiveMisses = 0;
    this.targetLostAt = null;
    
    // Ball detected - calculate position
    const ballCenterX = ballDetection.x + ballDetection.width / 2;
    const fovAngle = this.pixelToAngle(ballCenterX, effectiveFrameWidth);
    const detectedBallAngle = currentServoPos - this.fieldOfView / 2 + fovAngle;
    if (ballCandidate) {
      this.lastValidRadial = {
        r: ballCandidate.r,
        worldAngleDeg: ballCandidate.worldAngleDeg,
        targetFovAngleDeg: ballCandidate.targetFovAngleDeg,
        servoPosDeg: currentServoPos,
        tsMs: now,
      };
    }
    this.state.lastDetectedBallAngle = detectedBallAngle;
    
    // Target is visible - track it
    if (this.state.isSearching || !this.state.isTracking) {
      // Just found target - exit search mode
      console.log('✅ [Control] Target found - exiting search mode');
      this.state.isSearching = false;
      this.state.isTracking = true;
    }
    
    // Calculate error: distance from center of image
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
    const newServoTarget = currentServoPos + displacement;
    
    // Clamp to valid range
    const clampedTarget = Math.max(0, Math.min(180, newServoTarget));
    
    // Update servo target
    this.servo.moveTo(clampedTarget);
    this.state.targetAngle = clampedTarget;
    
    // Calculate time to move
    const timeMs = this.servo.getTimeToTarget(currentServoPos);
    
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
    this.consecutiveMisses = 0;
    this.searchDirection = 1;
    this.lastValidRadial = null;
    this.controller.reset();
    this.servo.moveTo(90.0);
  }

  private selectBestBallCandidate(
    detections: Detection[],
    currentServoPos: number,
    frameWidth: number,
    nowMs: number
  ): { det: Detection; r: number; worldAngleDeg: number; targetFovAngleDeg: number } | null {
    const BALL_LABELS = ['basketball'];
    const candidates = detections
      .filter((det) => BALL_LABELS.includes(String(det.className ?? det.class).toLowerCase()))
      .map((det) => {
        if (det.width < this.minDetectionWidthPx) {
          console.log(`🧪 [DetScore] reject(small_width) width=${det.width.toFixed(2)} minWidth=${this.minDetectionWidthPx.toFixed(2)}`);
          return null;
        }
        const confidence = Number.isFinite(det.confidence) ? det.confidence : 0;
        const passesConfidenceCutoff = confidence >= 0.5;

        const ballCenterX = det.x + det.width / 2;
        const fovAngle = this.pixelToAngle(ballCenterX, frameWidth);
        const worldAngleDeg = currentServoPos - this.fieldOfView / 2 + fovAngle;

        // Relative depth proxy: width ratio and tan(FOV/2).
        const safeWidthNorm = Math.max(det.width / Math.max(1, frameWidth), 1e-3);
        const tanHalfFov = Math.max(1e-3, Math.tan((this.fieldOfView * Math.PI) / 360));
        const r = 1 / (safeWidthNorm * tanHalfFov);

        const confidenceScore = Math.max(0, Math.min(1, (confidence - 0.3) / 0.7));
        let motionScore = 0.5;
        let speed = 0;
        if (this.lastValidRadial) {
          const dtSec = Math.max((nowMs - this.lastValidRadial.tsMs) / 1000, 1e-3);
          const prevWorldAngleDeg =
            this.lastValidRadial.servoPosDeg -
            this.fieldOfView / 2 +
            this.lastValidRadial.targetFovAngleDeg;
          const deltaAngleDegAbs = Math.abs(worldAngleDeg - prevWorldAngleDeg);
          const deltaAngleRad = (deltaAngleDegAbs * Math.PI) / 180;
          const dist = Math.sqrt(
            Math.max(
              0,
              this.lastValidRadial.r * this.lastValidRadial.r +
                r * r -
                2 * this.lastValidRadial.r * r * Math.cos(deltaAngleRad)
            )
          );
          speed = dist / dtSec;
          // Penalize implausibly fast jumps in radial space.
          const speedScale = 7;
          motionScore = 1 / (1 + (speed / speedScale) * (speed / speedScale));
        }

        const totalScore = 0.55 * confidenceScore + 0.45 * motionScore;
        console.log(
          `🧪 [DetScore] conf=${confidence.toFixed(3)} confS=${confidenceScore.toFixed(3)} motionS=${motionScore.toFixed(3)} speed=${speed.toFixed(3)} total=${totalScore.toFixed(3)} passConf=${passesConfidenceCutoff}`
        );
        if (!passesConfidenceCutoff) {
          return null;
        }
        return { det, r, worldAngleDeg, targetFovAngleDeg: fovAngle, totalScore };
      })
      .filter((item): item is { det: Detection; r: number; worldAngleDeg: number; targetFovAngleDeg: number; totalScore: number } => item !== null)
      .sort((a, b) => b.totalScore - a.totalScore);

    if (candidates.length === 0) {
      return null;
    }
    const best = candidates[0];
    const threshold = this.lastValidRadial ? 0.55 : 0.5;
    if (best.totalScore < threshold) {
      return null;
    }
    return {
      det: best.det,
      r: best.r,
      worldAngleDeg: best.worldAngleDeg,
      targetFovAngleDeg: best.targetFovAngleDeg,
    };
  }
}
