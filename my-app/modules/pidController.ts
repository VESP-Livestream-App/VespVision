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
  derivativeBufferSize?: number;  // Number of samples for derivative smoothing (default: 3, 1 = no smoothing)
}

export class PIDController {
  private readonly kp: number;
  private readonly ki: number;
  private readonly kd: number;
  private readonly integralLimit: number;
  private readonly derivativeBufferSize: number;
  
  private integralError: number = 0;
  private errorBuffer: number[] = [];  // Circular buffer for derivative smoothing
  private timeBuffer: number[] = [];   // Time stamps for each error sample
  private bufferIndex: number = 0;
  private lastUpdateTime: number | null = null;

  constructor(config: PIDConfig = {}) {
    this.kp = config.kp ?? 25.0;
    this.ki = config.ki ?? 0.0;
    this.kd = config.kd ?? 0.0;
    this.integralLimit = config.integralLimit ?? 100.0;
    this.derivativeBufferSize = config.derivativeBufferSize ?? 3;
  }

  /**
   * Compute control signal from normalized error using PID algorithm
   * 
   * @param normalizedError - Error normalized to [-1.0, 1.0] range
   *   - -1.0: Target is at left edge of FOV
   *   - 0.0: Target is at center
   *   - +1.0: Target is at right edge of FOV
   * 
   * @returns Control signal (Kp*e + Ki*integral(e) + Kd*de/dt)
   */
  computeControl(normalizedError: number): number {
    const now = Date.now();
    
    // Clamp error to valid range
    const clampedError = Math.max(-1.0, Math.min(1.0, normalizedError));
    
    // Calculate time delta (dt) in seconds
    let dt = 0.1; // Default 100ms if first call
    if (this.lastUpdateTime !== null) {
      dt = (now - this.lastUpdateTime) / 1000.0; // Convert ms to seconds
    }
    this.lastUpdateTime = now;
    
    // Proportional term
    const proportional = this.kp * clampedError;
    
    // Integral term (accumulate error over time)
    this.integralError += clampedError * dt;
    
    // Anti-windup: clamp integral to prevent excessive accumulation
    this.integralError = Math.max(
      -this.integralLimit,
      Math.min(this.integralLimit, this.integralError)
    );
    const integral = this.ki * this.integralError;
    
    // Derivative term (rate of change of error)
    // Use buffered approach to smooth noisy camera detections
    let derivative = 0;
    
    // Add current error to circular buffer
    if (this.errorBuffer.length < this.derivativeBufferSize) {
      // Buffer not full yet - just append
      this.errorBuffer.push(clampedError);
      this.timeBuffer.push(now);
    } else {
      // Buffer full - replace oldest entry (circular)
      this.errorBuffer[this.bufferIndex] = clampedError;
      this.timeBuffer[this.bufferIndex] = now;
      this.bufferIndex = (this.bufferIndex + 1) % this.derivativeBufferSize;
    }
    
    // Calculate derivative using oldest vs newest sample (smoothed over buffer window)
    if (this.errorBuffer.length >= 2) {
      const newestError = clampedError;
      const newestTime = now;
      
      // Get oldest sample from buffer
      const oldestIndex = this.errorBuffer.length < this.derivativeBufferSize 
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
    
    // Final control signal
    const controlSignal = proportional + integral + derivative;
    
    return controlSignal;
  }

  /**
   * Reset PID state (clear integral and derivative history)
   */
  reset(): void {
    this.integralError = 0;
    this.errorBuffer = [];
    this.timeBuffer = [];
    this.bufferIndex = 0;
    this.lastUpdateTime = null;
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
   * Create new controller with different gains
   */
  withGains(kp?: number, ki?: number, kd?: number): PIDController {
    return new PIDController({
      kp: kp ?? this.kp,
      ki: ki ?? this.ki,
      kd: kd ?? this.kd,
      integralLimit: this.integralLimit,
      derivativeBufferSize: this.derivativeBufferSize,
    });
  }
}
