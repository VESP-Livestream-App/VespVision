/**
 * Async Inference Queue
 * 
 * Industry best practices for smooth ML inference:
 * 1. Non-blocking queue - Don't wait for inference to complete
 * 2. Frame dropping - Skip frames if inference is busy
 * 3. Latest result only - Use most recent result, discard old ones
 * 4. Dedicated thread pool - Already handled by native modules
 */

type InferenceTask = {
  id: number;
  rgbData: number[];
  frameWidth: number;
  frameHeight: number;
  resizedWidth: number;
  resizedHeight: number;
  padX: number;
  padY: number;
  scale: number;
  resolve: (detections: any[]) => void;
  reject: (error: Error) => void;
};

class InferenceQueue {
  private queue: InferenceTask[] = [];
  private isProcessing = false;
  private currentTaskId: number | null = null;
  private latestResult: any[] = [];
  private taskIdCounter = 0;
  private maxQueueSize = 5; // Increased for maximum rate - queue will drop old frames

  /**
   * Add inference task to queue (non-blocking)
   * Returns immediately, result comes via callback
   */
  async enqueue(
    rgbData: number[],
    frameWidth: number,
    frameHeight: number,
    resizedWidth: number,
    resizedHeight: number,
    padX: number,
    padY: number,
    scale: number
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const taskId = ++this.taskIdCounter;
      const enqueuedAt = Date.now();
      const task: InferenceTask & { enqueuedAt: number } = {
        id: taskId,
        rgbData,
        frameWidth,
        frameHeight,
        resizedWidth,
        resizedHeight,
        padX,
        padY,
        scale,
        resolve,
        reject,
        enqueuedAt,
      };

      // If queue is full, drop oldest task (frame dropping)
      if (this.queue.length >= this.maxQueueSize) {
        const dropped = this.queue.shift();
        if (dropped) {
          // Resolve with latest result (better than nothing)
          dropped.resolve(this.latestResult);
        }
      }

      this.queue.push(task);
      this.processQueue();
    });
  }

  /**
   * Process queue asynchronously (non-blocking)
   */
  private async processQueue() {
    // Already processing or no tasks - prevent concurrent processing
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    // Set processing flag immediately to prevent race conditions
    this.isProcessing = true;

    while (this.queue.length > 0) {
      // Get the latest task (drop older ones if multiple queued)
      // This ensures we always process the most recent frame
      const task = this.queue.pop()!;
      
      // Drop any remaining older tasks
      while (this.queue.length > 0) {
        const dropped = this.queue.shift()!;
        dropped.resolve(this.latestResult); // Return latest result
      }

      this.currentTaskId = task.id;

      // Timing: Track queue wait time and processing time
      const queueWaitTime = Date.now() - (task as any).enqueuedAt || 0;
      const processingStartTime = Date.now();

      try {
        // Import dynamically to avoid circular dependencies
        const { runYoloInference } = await import('./yoloInference');
        
        // Run inference (already on background thread in native code)
        // Note: rgbData is already padded to input size
        const { getYOLOInputSize } = await import('./yoloUtils');
        const inputSize = getYOLOInputSize();
        const inferenceStartTime = Date.now();
        const detections = await runYoloInference(
          task.rgbData,
          inputSize, // Padded width
          inputSize, // Padded height
          {
            boxIsNormalized: true,
          }
        );
        const inferenceDuration = Date.now() - inferenceStartTime;
        const totalProcessingTime = Date.now() - processingStartTime;
        
        // Log detailed timing
        console.log(`⏱️ [Inference Timing]`, {
          taskId: task.id,
          queueWait: `${queueWaitTime}ms`,
          inferenceTime: `${inferenceDuration}ms`,
          totalProcessing: `${totalProcessingTime}ms`,
          queueSize: this.queue.length,
          throughput: `${Math.round(1000 / totalProcessingTime)} FPS`,
        });

        // Correct bounding boxes for original frame size
        const corrected = detections.map((det) => {
          const x = (det.x - task.padX) / task.scale;
          const y = (det.y - task.padY) / task.scale;
          const width = det.width / task.scale;
          const height = det.height / task.scale;
          return {
            ...det,
            x: Math.max(0, Math.min(task.frameWidth - 1, x)),
            y: Math.max(0, Math.min(task.frameHeight - 1, y)),
            width: Math.max(1, Math.min(task.frameWidth, width)),
            height: Math.max(1, Math.min(task.frameHeight, height)),
          };
        });

        // Update latest result
        this.latestResult = corrected;

        // Resolve this task
        task.resolve(corrected);
      } catch (error) {
        console.error('❌ Inference queue error:', error);
        task.reject(error as Error);
      }

      this.currentTaskId = null;
    }

    this.isProcessing = false;
  }

  /**
   * Get latest result without waiting
   */
  getLatestResult(): any[] {
    return this.latestResult;
  }

  /**
   * Clear queue and cancel pending tasks
   */
  clear() {
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.resolve(this.latestResult); // Return latest result
    }
    this.isProcessing = false;
    this.currentTaskId = null;
  }

  /**
   * Check if queue is processing
   */
  isBusy(): boolean {
    return this.isProcessing;
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.queue.length;
  }
}

// Singleton instance
export const inferenceQueue = new InferenceQueue();
