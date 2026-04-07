/**
 * PID Controller Module
 * 
 * Implements a PID (Proportional-Integral-Derivative) controller for visual servoing.
 * Converts percent error into control signal using PID algorithm.
 */

export interface PIDConfig {
  kp?: number;  // Proportional gain (default: 25.0)
  ki?: number;  // Integral gain (default: 0.0)
  kd?: number;  // Derivative gain (default: 0.0)
  integralLimit?: number;  // Anti-windup limit for integral term (default: 100.0)
  derivativeBufferSize?: number;  // Number of samples for derivative smoothing (default: 3)
  /**
   * Input low-pass filter alpha.
   * Range: 0.0-1.0, default: 0.3
   */
  inputFilterAlpha?: number;  // Input low-pass alpha (default: 0.3, range: 0.0-1.0)
  /**
   * Deadband threshold for output control signal magnitude.
   * Default: 2.0
   */
  outputDeadband?: number;  // Output deadband threshold (default: 2.0)
}

export class PIDController {
  private static readonly STALE_THRESHOLD_MS = 500;

  private readonly kp: number;
  private readonly ki: number;
  private readonly kd: number;
  private readonly integralLimit: number;
  private readonly derivativeBufferSize: number;
  private readonly inputFilterAlpha: number;
  private readonly outputDeadband: number;
  
  private integralError: number = 0;
  private filteredError: number = 0;
  private errorBuffer: number[] = [];  // Circular buffer for derivative smoothing
  private timeBuffer: number[] = [];   // Time stamps for each error sample
  private bufferIndex: number = 0;
  private lastUpdateTime: number | null = null;
  private lastOutput: number = 0;

  constructor(config: PIDConfig = {}) {
    this.kp = config.kp ?? 25.0;
    this.ki = config.ki ?? 0.0;
    this.kd = config.kd ?? 0.0;
    this.integralLimit = config.integralLimit ?? 100.0;
    this.derivativeBufferSize = config.derivativeBufferSize ?? 3;
    const alpha = config.inputFilterAlpha ?? 0.25;
    this.inputFilterAlpha = Math.max(0, Math.min(1, alpha));
    this.outputDeadband = config.outputDeadband ?? 4.0;
  }

  /**
   * Compute control signal from normalized error using PID algorithm
   * 
   * @param normalizedError - Error normalized to [-1.0, 1.0] range
   *   - -1.0: Target is at left edge of FOV
   *   - 0.0: Target is at center
   *   - +1.0: Target is at right edge of FOV
   * 
   * @param detectionValid - True when the current frame has a valid target detection.
   *   If false, the controller freezes PID state and returns the last output.
   *
   * @returns Control signal (Kp*e + Ki*integral(e) + Kd*de/dt)
   */
  computeControl(normalizedError: number, detectionValid: boolean): number {
    const now = Date.now();
    if (!detectionValid) {
      // Keep time fresh to avoid large dt spikes when detections resume.
      this.lastUpdateTime = now;
      return this.lastOutput;
    }

    if (
      this.lastUpdateTime !== null &&
      now - this.lastUpdateTime > PIDController.STALE_THRESHOLD_MS
    ) {
      // Clear derivative history after a stale gap, but preserve integral bias.
      this.errorBuffer = [];
      this.timeBuffer = [];
      this.bufferIndex = 0;
      this.lastUpdateTime = now;
    }
    
    // Clamp error to valid range
    const clampedError = Math.max(-1.0, Math.min(1.0, normalizedError));
    this.filteredError = this.inputFilterAlpha * clampedError + (1 - this.inputFilterAlpha) * this.filteredError;
    
    // Calculate time delta (dt) in seconds
    let dt = 0.1; // Default 100ms if first call
    if (this.lastUpdateTime !== null) {
      dt = (now - this.lastUpdateTime) / 1000.0; // Convert ms to seconds
    }
    this.lastUpdateTime = now;
    
    // Proportional term
    const proportional = this.kp * this.filteredError;
    
    // Integral term (accumulate error over time)
    this.integralError += this.filteredError * dt;
    
    // Anti-windup: clamp integral to prevent excessive accumulation
    this.integralError = Math.max(
      -this.integralLimit,
      Math.min(this.integralLimit, this.integralError)
    );
    const integral = this.ki * this.integralError;
    
    // Derivative term (rate of change of error)
    // Use buffered approach to smooth noisy camera detections
    let derivative = 0;
    const derivativeWindowSize = Math.max(2, this.derivativeBufferSize);
    
    // Add current error to circular buffer
    if (this.errorBuffer.length < derivativeWindowSize) {
      // Buffer not full yet - just append
      this.errorBuffer.push(clampedError);
      this.timeBuffer.push(now);
    } else {
      // Buffer full - replace oldest entry (circular)
      this.errorBuffer[this.bufferIndex] = clampedError;
      this.timeBuffer[this.bufferIndex] = now;
      this.bufferIndex = (this.bufferIndex + 1) % derivativeWindowSize;
    }
    
    // Calculate derivative using oldest vs newest sample (smoothed over buffer window)
    if (this.errorBuffer.length >= 2) {
      const newestError = clampedError;
      const newestTime = now;
      
      // Get oldest sample from buffer
      const oldestIndex = this.errorBuffer.length < derivativeWindowSize 
        ? 0  // Buffer not full, use first element
        : this.bufferIndex;  // Buffer full, oldest is at bufferIndex
      
      const oldestError = this.errorBuffer[oldestIndex];
      const oldestTime = this.timeBuffer[oldestIndex];
      
      const timeDelta = (newestTime - oldestTime) / 1000.0; // Convert to seconds
      
      if (timeDelta > 0) {
        const errorRate = (newestError - oldestError) / timeDelta;
        derivative = this.kd * errorRate;
      }
    }
    
    // Final control 
    console.log(`PID computeControl: P=${proportional.toFixed(2)} I=${integral.toFixed(2)} D=${derivative.toFixed(2)} (error=${clampedError.toFixed(2)}, dt=${dt.toFixed(3)})`);
    const controlSignal = proportional + integral + derivative;
    if (Math.abs(controlSignal) < this.outputDeadband) {
      // Undo integral accumulation for this frame to avoid windup in deadband.
      this.integralError -= clampedError * dt;
      this.integralError = Math.max(
        -this.integralLimit,
        Math.min(this.integralLimit, this.integralError)
      );
      this.lastOutput = 0;
      return 0;
    }
    this.lastOutput = controlSignal;
    
    return controlSignal;
  }

  /**
   * Reset PID state (clear integral and derivative history)
   */
  reset(): void {
    this.integralError = 0;
    this.filteredError = 0;
    this.errorBuffer = [];
    this.timeBuffer = [];
    this.bufferIndex = 0;
    this.lastUpdateTime = null;
    this.lastOutput = 0;
  }

  /**
   * Get current PID gains
   */
  getGains(): { kp: number; ki: number; kd: number } {
    return { kp: this.kp, ki: this.ki, kd: this.kd };
  }

  /**
   * Get current integral accumulation (for debugging)
   */
  getIntegralError(): number {
    return this.integralError;
  }

  /**
   * Get the most recently computed PID output.
   */
  getLastOutput(): number {
    return this.lastOutput;
  }

  /**
   * Get the most recent low-pass filtered error value.
   */
  getFilteredError(): number {
    return this.filteredError;
  }

  /**
   * Check whether the controller state is stale (not updated recently).
   *
   * @param thresholdMs - Max allowed age in milliseconds for the latest update.
   *   If exceeded (or if never updated), returns true.
   */
  isStale(thresholdMs: number = 500): boolean {
    if (this.lastUpdateTime === null) {
      return true;
    }
    return Date.now() - this.lastUpdateTime > thresholdMs;
  }

  /**
   * Create new controller with different gains
   */
  withGains(kp?: number, ki?: number, kd?: number): PIDController {
    return new PIDController({
      kp: kp ?? this.kp,
      ki: ki ?? this.ki,
      kd: kd ?? this.kd,
      integralLimit: this.integralLimit,
      derivativeBufferSize: this.derivativeBufferSize,
      inputFilterAlpha: this.inputFilterAlpha,
      outputDeadband: this.outputDeadband,
    });
  }
}
