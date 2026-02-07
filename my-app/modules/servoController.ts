/**
 * Servo Controller Module
 * 
 * Translates the Python Servo class to TypeScript.
 * Manages servo position tracking, target setting, and search mode.
 * 
 * Note: The actual servo position is read from BLE (currentPos),
 * but we track the target position and compute expected movements.
 */

export interface ServoConfig {
  initialPos?: number;      // Initial position in degrees (0-180)
  speed?: number;           // Speed in degrees per second
  minPos?: number;          // Minimum position (default: 0)
  maxPos?: number;          // Maximum position (default: 180)
}

export class Servo {
  private _targetPos: number;
  private readonly speed: number; // degrees per second
  private readonly minPos: number;
  private readonly maxPos: number;
  private searching: boolean = false;

  constructor(config: ServoConfig = {}) {
    const {
      initialPos = 90.0,
      speed = 60.0,
      minPos = 0.0,
      maxPos = 180.0,
    } = config;

    this._targetPos = Math.max(minPos, Math.min(maxPos, initialPos));
    this.speed = speed;
    this.minPos = minPos;
    this.maxPos = maxPos;
  }

  /**
   * Get current target position
   */
  get targetPos(): number {
    return this._targetPos;
  }

  /**
   * Check if servo is in search mode
   */
  get isSearching(): boolean {
    return this.searching;
  }

  /**
   * Move servo to a specific position
   * @param position - Target position in degrees (0-180)
   */
  moveTo(position: number): void {
    this.searching = false;
    
    // Clamp value to valid range
    const clamped = Math.max(this.minPos, Math.min(this.maxPos, position));
    
    this._targetPos = clamped;
  }

  /**
   * Start search mode - oscillate between edges to find target
   * @param direction - 1 for left-to-right search, -1 for right-to-left
   * @param fieldOfView - Field of view in degrees (for edge calculation)
   * @param edgeRedundancyFactor - Fraction of FOV to use as edge buffer (default: 0.25)
   */
  searchTarget(
    direction: number,
    fieldOfView: number,
    edgeRedundancyFactor: number = 0.25
  ): void {
    this.searching = true;

    // Calculate start angle based on direction
    // Left-to-right: start near left edge
    // Right-to-left: start near right edge
    const startAngle = direction > 0
      ? this.minPos + Math.floor(fieldOfView * edgeRedundancyFactor)
      : this.maxPos - Math.floor(fieldOfView * edgeRedundancyFactor);
    
    this._targetPos = Math.max(this.minPos, Math.min(this.maxPos, startAngle));
  }

  /**
   * Update search mode - oscillate between edges
   * This should be called periodically when in search mode
   * @param currentPos - Current actual position from BLE
   * @param fieldOfView - Field of view in degrees
   */
  updateSearch(currentPos: number, fieldOfView: number, edgeRedundancyFactor: number = 0.25): void {
    if (!this.searching) {
      return;
    }

    const fovQuarter = Math.floor(fieldOfView * edgeRedundancyFactor);
    
    // If reached left edge, move to right edge
    if (currentPos <= this.minPos + fovQuarter) {
      this._targetPos = this.maxPos - fovQuarter;
    }
    // If reached right edge, move to left edge
    else if (currentPos >= this.maxPos - fovQuarter) {
      this._targetPos = this.minPos + fovQuarter;
    }
  }

  /**
   * Calculate time needed to move from current position to target
   * @param currentPos - Current position in degrees
   * @returns Time in milliseconds
   */
  getTimeToTarget(currentPos: number): number {
    const distance = Math.abs(this._targetPos - currentPos);
    const timeSeconds = distance / this.speed;
    return Math.max(0, Math.round(timeSeconds * 1000));
  }
}
