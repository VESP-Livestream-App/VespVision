// YOLO11n utility functions for processing detections

export interface Detection {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  class: number;
  className?: string;
}

export interface YOLOConfig {
  inputSize: number; // Typically 640 for YOLO11n
  numClasses: number; // Usually 80 for COCO
  confidenceThreshold: number; // e.g., 0.5
  nmsThreshold: number; // Non-maximum suppression threshold, e.g., 0.4
  applySigmoid?: boolean; // Apply sigmoid to objectness/class scores
  boxIsNormalized?: boolean; // If false, treat box coords as pixels
}

// Default COCO class names (YOLO11n typically trained on COCO dataset)
// export const COCO_CLASS_NAMES = [
//   'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
//   'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
//   'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
//   'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
//   'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
//   'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup',
//   'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
//   'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
//   'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
//   'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
//   'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
//   'toothbrush'
// ];
export const COCO_CLASS_NAMES = [
  'basketball','rim'
];

/**
 * Parse YOLO11n output tensor to detections
 * YOLO11n typically outputs: [1, 8400, 85] or [8400, 85]
 * Format: [x_center, y_center, width, height, class_0_score, ..., class_79_score]
 * Or sometimes: [x_center, y_center, width, height, confidence, class_0_score, ..., class_79_score]
 */
export function parseYOLOOutput(
  output: number[],
  frameWidth: number,
  frameHeight: number,
  config: YOLOConfig = {
    inputSize: 640,
    numClasses: 2, //80 for COCO
    confidenceThreshold: 0.5,
    nmsThreshold: 0.4,
    applySigmoid: false,
    boxIsNormalized: true,
  }
): Detection[] {
  const detections: Detection[] = [];
  
  // Some exports output [num_boxes, 6] => [x1, y1, x2, y2, conf, class_id]
  if (output.length % 6 === 0 && output.length / 6 <= 10000) {
    const numBoxes = output.length / 6;
    for (let i = 0; i < numBoxes; i++) {
      const base = i * 6;
      const x1 = output[base];
      const y1 = output[base + 1];
      const x2 = output[base + 2];
      const y2 = output[base + 3];
      const confidence = output[base + 4];
      const classId = Math.round(output[base + 5]);
      if (confidence < config.confidenceThreshold) {
        continue;
      }

      const x1Px = config.boxIsNormalized ? x1 * frameWidth : x1;
      const y1Px = config.boxIsNormalized ? y1 * frameHeight : y1;
      const x2Px = config.boxIsNormalized ? x2 * frameWidth : x2;
      const y2Px = config.boxIsNormalized ? y2 * frameHeight : y2;
      const width = Math.max(0, x2Px - x1Px);
      const height = Math.max(0, y2Px - y1Px);

      detections.push({
        x: x1Px,
        y: y1Px,
        width,
        height,
        confidence,
        class: classId,
        className: COCO_CLASS_NAMES[classId],
      });
    }
    return applyNMS(detections, config.nmsThreshold);
  }

  // YOLO models typically output 8400 predictions
  const numPredictions = output.length % 8400 === 0 ? 8400 : Math.floor(output.length / (4 + config.numClasses));
  const numValuesPerPrediction = output.length / numPredictions;
  const hasObjectness = numValuesPerPrediction === config.numClasses + 5;
  const classOffset = hasObjectness ? 5 : 4;
  
  for (let i = 0; i < numPredictions; i++) {
    const baseIndex = i * numValuesPerPrediction;
    
    // Extract bounding box coordinates (normalized 0-1)
    const xCenter = output[baseIndex];
    const yCenter = output[baseIndex + 1];
    const width = output[baseIndex + 2];
    const height = output[baseIndex + 3];
    
    // Find class with highest score
    let maxScore = 0;
    let maxClassIndex = 0;
    
    let objectness = hasObjectness ? output[baseIndex + 4] : 1;
    if (config.applySigmoid && hasObjectness) {
      objectness = sigmoid(objectness);
    }
    for (let j = 0; j < config.numClasses; j++) {
      const classScore = output[baseIndex + classOffset + j];
      const score = (config.applySigmoid ? sigmoid(classScore) : classScore) * objectness;
      if (score > maxScore) {
        maxScore = score;
        maxClassIndex = j;
      }
    }
    
    // Apply confidence threshold
    if (maxScore >= config.confidenceThreshold) {
      // Convert normalized coordinates to pixel coordinates
      // Account for potential letterboxing/resizing
      const scaleX = frameWidth / config.inputSize;
      const scaleY = frameHeight / config.inputSize;
      const xCenterPx = config.boxIsNormalized ? xCenter * config.inputSize : xCenter;
      const yCenterPx = config.boxIsNormalized ? yCenter * config.inputSize : yCenter;
      const widthPx = config.boxIsNormalized ? width * config.inputSize : width;
      const heightPx = config.boxIsNormalized ? height * config.inputSize : height;

      detections.push({
        x: (xCenterPx - widthPx / 2) * scaleX,
        y: (yCenterPx - heightPx / 2) * scaleY,
        width: widthPx * scaleX,
        height: heightPx * scaleY,
        confidence: maxScore,
        class: maxClassIndex,
        className: COCO_CLASS_NAMES[maxClassIndex],
      });
    }
  }
  
  // Apply Non-Maximum Suppression (NMS)
  return applyNMS(detections, config.nmsThreshold);
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/**
 * Simple Non-Maximum Suppression implementation
 */
function applyNMS(detections: Detection[], nmsThreshold: number): Detection[] {
  // Sort by confidence descending
  detections.sort((a, b) => b.confidence - a.confidence);
  
  const selected: Detection[] = [];
  
  for (const detection of detections) {
    let shouldAdd = true;
    
    for (const selectedDetection of selected) {
      if (detection.class === selectedDetection.class) {
        const iou = calculateIOU(detection, selectedDetection);
        if (iou > nmsThreshold) {
          shouldAdd = false;
          break;
        }
      }
    }
    
    if (shouldAdd) {
      selected.push(detection);
    }
  }
  
  return selected;
}

/**
 * Calculate Intersection over Union (IOU) between two bounding boxes
 */
function calculateIOU(box1: Detection, box2: Detection): number {
  const x1 = Math.max(box1.x, box2.x);
  const y1 = Math.max(box1.y, box2.y);
  const x2 = Math.min(box1.x + box1.width, box2.x + box2.width);
  const y2 = Math.min(box1.y + box1.height, box2.y + box2.height);
  
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area1 = box1.width * box1.height;
  const area2 = box2.width * box2.height;
  const union = area1 + area2 - intersection;
  
  return union > 0 ? intersection / union : 0;
}

/**
 * Prepare input shape for YOLO11n model
 */
// Configurable input size for performance tuning
// Lower resolution = faster inference (with accuracy trade-off)
// 640 = original, 416 = 2.4x faster, 320 = 4x faster
export const YOLO_INPUT_SIZE = 640; // Original size (reverted)

export function getYOLOInputShape(): number[] {
  // YOLO11n can work with different input sizes
  return [1, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE, 3];
}

export function getYOLOInputSize(): number {
  return YOLO_INPUT_SIZE;
}

/**
 * Normalize input values to [0, 1] range for YOLO input
 */
export function normalizeInput(data: Uint8Array): number[] {
  const normalized: number[] = [];
  for (let i = 0; i < data.length; i++) {
    normalized.push(data[i] / 255.0);
  }
  return normalized;
}
