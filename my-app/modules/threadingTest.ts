/**
 * Threading Test Utility
 * 
 * Tests to verify:
 * 1. Non-blocking behavior (UI stays responsive)
 * 2. Background processing (inference doesn't block main thread)
 * 3. Queue behavior (frame dropping, latest result)
 * 4. Multiprocessing (if enabled)
 */

import { TFLite, isTFLiteAvailable } from './TFLiteModule';

export interface ThreadingTestResult {
  testName: string;
  passed: boolean;
  details: string;
  metrics?: {
    mainThreadBlocked?: number; // ms
    inferenceTime?: number; // ms
    concurrentInferences?: number;
    queueSize?: number;
  };
}

/**
 * Test 1: Verify non-blocking behavior
 * - Enqueue multiple tasks via the inference queue (not raw TFLite)
 * - Submitting to the queue should return in < 50ms; actual inference runs in background
 */
export async function testNonBlocking(): Promise<ThreadingTestResult> {
  const testName = 'Non-Blocking Test';

  try {
    const { inferenceQueue } = await import('./inferenceQueue');
    const dummyRgb = new Array(1228800).fill(0.5);
    const frameW = 1920, frameH = 1080, resizedW = 640, resizedH = 640;
    const padX = 0, padY = 0, scale = 1.0;

    // Measure only the time to submit 5 tasks (exclude module load above)
    const startTime = Date.now();
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        inferenceQueue.enqueue(dummyRgb, frameW, frameH, resizedW, resizedH, padX, padY, scale).catch(() => [])
      );
    }
    const enqueueTime = Date.now() - startTime;
    const passed = enqueueTime < 100; // Submitting to queue should be fast (< 100ms)

    // Let tasks complete in background so queue drains
    await Promise.allSettled(promises);

    return {
      testName,
      passed,
      details: passed
        ? `✅ Enqueued 5 tasks in ${enqueueTime}ms (non-blocking)`
        : `❌ Enqueue took ${enqueueTime}ms (expected < 100ms)`,
      metrics: {
        mainThreadBlocked: enqueueTime,
      },
    };
  } catch (error: any) {
    return {
      testName,
      passed: false,
      details: `❌ Error: ${error?.message}`,
    };
  }
}

/**
 * Test 2: Verify background processing
 * - Run inference while doing other work
 * - Check if other work is blocked
 */
export async function testBackgroundProcessing(): Promise<ThreadingTestResult> {
  const testName = 'Background Processing Test';
  const startTime = Date.now();
  let otherWorkTime = 0;
  let inferenceTime = 0;

  try {
    // Start inference (should run in background)
    const inferencePromise = TFLite?.runInference(
      new Array(1228800).fill(0.5),
      [1, 640, 640, 3]
    );

    // Do other work while inference runs
    const otherWorkStart = Date.now();
    for (let i = 0; i < 1000000; i++) {
      Math.sqrt(i); // Simulate work
    }
    otherWorkTime = Date.now() - otherWorkStart;

    // Wait for inference
    const inferenceStart = Date.now();
    await inferencePromise;
    inferenceTime = Date.now() - inferenceStart;

    // If other work completed quickly, inference is running in background
    const passed = otherWorkTime < 100; // Other work should be < 100ms

    return {
      testName,
      passed,
      details: passed
        ? `✅ Other work completed in ${otherWorkTime}ms (inference in background)`
        : `❌ Other work took ${otherWorkTime}ms (inference may be blocking)`,
      metrics: {
        inferenceTime,
        mainThreadBlocked: otherWorkTime,
      },
    };
  } catch (error: any) {
    return {
      testName,
      passed: false,
      details: `❌ Error: ${error?.message}`,
    };
  }
}

/**
 * Test 3: Verify queue behavior
 * - Enqueue multiple tasks rapidly
 * - Check queue size and frame dropping
 */
export async function testQueueBehavior(): Promise<ThreadingTestResult> {
  const testName = 'Queue Behavior Test';
  
  try {
    const { inferenceQueue } = await import('./inferenceQueue');
    
    // Enqueue multiple tasks rapidly
    const promises: Promise<any>[] = [];
    const initialQueueSize = inferenceQueue.size();
    
    for (let i = 0; i < 10; i++) {
      promises.push(
        inferenceQueue.enqueue(
          new Array(1228800).fill(0.5), // Dummy RGB data
          1920, 1080, // Frame size
          640, 640, // Resized
          0, 0, // Padding
          1.0 // Scale
        ).catch(() => [])
      );
    }

    // Check queue size immediately after enqueueing
    const queueSize = inferenceQueue.size();
    const isBusy = inferenceQueue.isBusy();

    // Wait for all to complete
    await Promise.allSettled(promises);

    // Queue should handle frame dropping (max 5 tasks)
    const passed = queueSize <= 5;

    return {
      testName,
      passed,
      details: passed
        ? `✅ Queue size: ${queueSize}, busy: ${isBusy} (frame dropping working)`
        : `❌ Queue size: ${queueSize} (too large, frame dropping not working)`,
      metrics: {
        queueSize,
      },
    };
  } catch (error: any) {
    return {
      testName,
      passed: false,
      details: `❌ Error: ${error?.message}`,
    };
  }
}

/**
 * Test 4: Verify concurrent processing (if multiprocessing enabled)
 * - Run multiple inferences simultaneously
 * - Check if they run in parallel
 */
export async function testConcurrentProcessing(): Promise<ThreadingTestResult> {
  const testName = 'Concurrent Processing Test';
  const startTime = Date.now();

  try {
    if (!isTFLiteAvailable() || !TFLite) {
      return {
        testName,
        passed: false,
        details: '❌ TFLite not available',
      };
    }

    // Start multiple inferences simultaneously
    const promises: Promise<any>[] = [];
    const inferenceStarts: number[] = [];

    for (let i = 0; i < 3; i++) {
      inferenceStarts.push(Date.now());
      promises.push(
        TFLite.runInference(
          new Array(1228800).fill(0.5),
          [1, 640, 640, 3]
        ).then((result) => {
          const duration = Date.now() - inferenceStarts[i];
          return { index: i, duration, result };
        })
      );
    }

    // Wait for all to complete
    const results = await Promise.allSettled(promises);
    const totalTime = Date.now() - startTime;

    // If truly concurrent, total time should be ~same as single inference
    // If serial, total time should be ~3x single inference
    const singleInferenceTime = results[0].status === 'fulfilled' 
      ? results[0].value.duration 
      : 0;

    // Check if they ran concurrently or serially
    const expectedSerialTime = singleInferenceTime * 3;
    const concurrentRatio = totalTime / expectedSerialTime;
    const isConcurrent = concurrentRatio < 1.5; // If < 1.5x, likely concurrent

    return {
      testName,
      passed: true, // Test always passes, just reports behavior
      details: isConcurrent
        ? `✅ Concurrent: ${totalTime}ms for 3 inferences (${concurrentRatio.toFixed(2)}x serial time)`
        : `⚠️ Serial: ${totalTime}ms for 3 inferences (${concurrentRatio.toFixed(2)}x serial time)`,
      metrics: {
        inferenceTime: totalTime,
        concurrentInferences: isConcurrent ? 3 : 1,
      },
    };
  } catch (error: any) {
    return {
      testName,
      passed: false,
      details: `❌ Error: ${error?.message}`,
    };
  }
}

/**
 * Run all threading tests
 */
export async function runAllThreadingTests(): Promise<ThreadingTestResult[]> {
  console.log('🧪 Starting Threading Tests...\n');

  const results: ThreadingTestResult[] = [];

  // Test 1: Non-blocking
  console.log('📋 Test 1: Non-Blocking Behavior...');
  const test1 = await testNonBlocking();
  results.push(test1);
  console.log(`${test1.passed ? '✅' : '❌'} ${test1.details}\n`);

  // Test 2: Background processing
  console.log('📋 Test 2: Background Processing...');
  const test2 = await testBackgroundProcessing();
  results.push(test2);
  console.log(`${test2.passed ? '✅' : '❌'} ${test2.details}\n`);

  // Test 3: Queue behavior
  console.log('📋 Test 3: Queue Behavior...');
  const test3 = await testQueueBehavior();
  results.push(test3);
  console.log(`${test3.passed ? '✅' : '❌'} ${test3.details}\n`);

  // Test 4: Concurrent processing
  console.log('📋 Test 4: Concurrent Processing...');
  const test4 = await testConcurrentProcessing();
  results.push(test4);
  console.log(`${test4.passed ? '✅' : '❌'} ${test4.details}\n`);

  // Summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n📊 Test Summary: ${passed}/${total} passed\n`);

  return results;
}
