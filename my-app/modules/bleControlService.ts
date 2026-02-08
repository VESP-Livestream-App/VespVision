/**
 * BLE Control Service
 * 
 * Service layer that bridges the control loop with BLE communication.
 * This allows the control loop to send servo commands without directly
 * depending on React hooks.
 */

export interface BLECommand {
  angle: number;    // Target angle in degrees (0-180)
  timeMs: number;   // Time to move in milliseconds
}

export type SendCommandCallback = (deviceId: string, angle: number, timeMs: number) => Promise<void>;

/**
 * BLE Control Service
 * 
 * Wraps BLE communication for the control loop.
 * Must be initialized with a callback that sends commands via BLE.
 */
export class BLEControlService {
  private sendCommandCallback: SendCommandCallback | null = null;
  private connectedDeviceId: string | null = null;
  private lastCommandTime: number = 0;
  private readonly minCommandInterval: number = 100; // Minimum ms between commands

  /**
   * Initialize the service with BLE send callback
   * @param sendCommand - Callback function to send commands via BLE
   */
  initialize(sendCommand: SendCommandCallback): void {
    this.sendCommandCallback = sendCommand;
  }

  /**
   * Set the connected device ID
   * @param deviceId - BLE device ID, or null if disconnected
   */
  setConnectedDevice(deviceId: string | null): void {
    this.connectedDeviceId = deviceId;
  }

  /**
   * Check if a device is connected
   */
  isConnected(): boolean {
    return this.connectedDeviceId !== null;
  }

  /**
   * Send a servo command via BLE
   * @param command - Command with angle and time
   * @returns True if command was sent, false otherwise
   */
  async sendCommand(command: BLECommand): Promise<boolean> {
    if (!this.sendCommandCallback) {
      console.warn('⚠️ BLE Control Service not initialized');
      return false;
    }

    if (!this.connectedDeviceId) {
      console.warn('⚠️ No BLE device connected');
      return false;
    }

    // Rate limiting: don't send commands too frequently
    const now = Date.now();
    if (now - this.lastCommandTime < this.minCommandInterval) {
      return false;
    }

    try {
      await this.sendCommandCallback(
        this.connectedDeviceId,
        command.angle,
        command.timeMs
      );
      this.lastCommandTime = now;
      return true;
    } catch (error) {
      console.error('❌ Failed to send BLE command:', error);
      return false;
    }
  }

  /**
   * Reset the service
   */
  reset(): void {
    this.connectedDeviceId = null;
    this.lastCommandTime = 0;
  }
}

// Singleton instance
let bleControlServiceInstance: BLEControlService | null = null;

/**
 * Get the global BLE control service instance
 */
export function getBLEControlService(): BLEControlService {
  if (!bleControlServiceInstance) {
    bleControlServiceInstance = new BLEControlService();
  }
  return bleControlServiceInstance;
}
