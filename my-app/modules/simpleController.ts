/**
 * Simple Controller Module
 * 
 * Translates the Python SimpleController class to TypeScript.
 * Implements a proportional (P) controller for visual servoing.
 */

export interface ControllerConfig {
  gain?: number;  // Controller gain factor (default: 25.0)
}

export class SimpleController {
  private readonly gain: number;

  constructor(config: ControllerConfig = {}) {
    this.gain = config.gain ?? 25.0;
  }

  /**
   * Compute control signal from normalized error
   * 
   * @param normalizedError - Error normalized to [-1.0, 1.0] range
   *   - -1.0: Target is at left edge of FOV
   *   - 0.0: Target is at center
   *   - +1.0: Target is at right edge of FOV
   * 
   * @returns Control signal (gain * error)
   */
  computeControl(normalizedError: number): number {
    // Clamp error to valid range
    const clampedError = Math.max(-1.0, Math.min(1.0, normalizedError));
    
    return this.gain * clampedError;
  }

  /**
   * Get current gain value
   */
  getGain(): number {
    return this.gain;
  }

  /**
   * Set gain value (creates new controller instance)
   */
  withGain(gain: number): SimpleController {
    return new SimpleController({ gain });
  }
}
