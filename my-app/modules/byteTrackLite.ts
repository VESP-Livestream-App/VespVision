import type { Detection } from '@/modules/yoloUtils';

export type ByteTrackLiteOptions = {
  iouThreshold?: number;
  maxMisses?: number;
  maxPredictionMs?: number;
  velocitySmoothing?: number;
  confidenceDecayPerSecond?: number;
};

type FrameSize = { width: number; height: number };

type Track = {
  id: number;
  classId: number;
  className?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  lastUpdateMs: number;
  hits: number;
  misses: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const iou = (a: Track | Detection, b: Track | Detection): number => {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);
  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;
  const unionArea = a.width * a.height + b.width * b.height - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
};

const applyFrameClamp = (box: Detection, frame?: FrameSize): Detection => {
  if (!frame || frame.width <= 0 || frame.height <= 0) {
    return box;
  }
  const x = clamp(box.x, 0, frame.width - 1);
  const y = clamp(box.y, 0, frame.height - 1);
  const width = clamp(box.width, 1, frame.width - x);
  const height = clamp(box.height, 1, frame.height - y);
  return { ...box, x, y, width, height };
};

export class ByteTrackLite {
  private tracks: Track[] = [];
  private nextId = 1;

  private readonly iouThreshold: number;
  private readonly maxMisses: number;
  private readonly maxPredictionMs: number;
  private readonly velocitySmoothing: number;
  private readonly confidenceDecayPerSecond: number;

  constructor(options: ByteTrackLiteOptions = {}) {
    this.iouThreshold = options.iouThreshold ?? 0.2;
    this.maxMisses = options.maxMisses ?? 3;
    this.maxPredictionMs = options.maxPredictionMs ?? 1200;
    this.velocitySmoothing = options.velocitySmoothing ?? 0.6;
    this.confidenceDecayPerSecond = options.confidenceDecayPerSecond ?? 0.6;
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }

  update(detections: Detection[], timestampMs: number, frame?: FrameSize): Detection[] {
    const matchedTrackIds = new Set<number>();
    const matchedDetections = new Set<number>();
    const orderedDetections = [...detections].sort((a, b) => b.confidence - a.confidence);

    for (let detIndex = 0; detIndex < orderedDetections.length; detIndex += 1) {
      const det = orderedDetections[detIndex];
      let bestTrack: Track | null = null;
      let bestIoU = 0;

      for (const track of this.tracks) {
        if (matchedTrackIds.has(track.id)) {
          continue;
        }
        if (track.classId !== det.class) {
          continue;
        }
        const score = iou(track, det);
        if (score > bestIoU) {
          bestIoU = score;
          bestTrack = track;
        }
      }

      if (bestTrack && bestIoU >= this.iouThreshold) {
        matchedTrackIds.add(bestTrack.id);
        matchedDetections.add(detIndex);
        const dtSeconds = Math.max(0.001, (timestampMs - bestTrack.lastUpdateMs) / 1000);
        const nx = det.x;
        const ny = det.y;
        const nw = det.width;
        const nh = det.height;
        const vx = (nx - bestTrack.x) / dtSeconds;
        const vy = (ny - bestTrack.y) / dtSeconds;
        const vw = (nw - bestTrack.width) / dtSeconds;
        const vh = (nh - bestTrack.height) / dtSeconds;
        const alpha = this.velocitySmoothing;
        bestTrack.vx = alpha * vx + (1 - alpha) * bestTrack.vx;
        bestTrack.vy = alpha * vy + (1 - alpha) * bestTrack.vy;
        bestTrack.vw = alpha * vw + (1 - alpha) * bestTrack.vw;
        bestTrack.vh = alpha * vh + (1 - alpha) * bestTrack.vh;
        bestTrack.x = nx;
        bestTrack.y = ny;
        bestTrack.width = nw;
        bestTrack.height = nh;
        bestTrack.confidence = det.confidence;
        bestTrack.className = det.className;
        bestTrack.lastUpdateMs = timestampMs;
        bestTrack.hits += 1;
        bestTrack.misses = 0;
      }
    }

    for (let i = 0; i < orderedDetections.length; i += 1) {
      if (matchedDetections.has(i)) {
        continue;
      }
      const det = orderedDetections[i];
      this.tracks.push({
        id: this.nextId++,
        classId: det.class,
        className: det.className,
        x: det.x,
        y: det.y,
        width: det.width,
        height: det.height,
        confidence: det.confidence,
        vx: 0,
        vy: 0,
        vw: 0,
        vh: 0,
        lastUpdateMs: timestampMs,
        hits: 1,
        misses: 0,
      });
    }

    this.tracks = this.tracks.filter((track) => {
      if (!matchedTrackIds.has(track.id)) {
        track.misses += 1;
      }
      if (track.misses > this.maxMisses) {
        return false;
      }
      const ageMs = timestampMs - track.lastUpdateMs;
      return ageMs <= this.maxPredictionMs;
    });

    return this.tracks.map((track) => applyFrameClamp({
      x: track.x,
      y: track.y,
      width: track.width,
      height: track.height,
      confidence: track.confidence,
      class: track.classId,
      className: track.className,
      trackId: track.id,
      isPredicted: false,
    }, frame));
  }

  predict(timestampMs: number, frame?: FrameSize): Detection[] {
    const results: Detection[] = [];
    for (const track of this.tracks) {
      const dtMs = timestampMs - track.lastUpdateMs;
      if (dtMs <= 0 || dtMs > this.maxPredictionMs) {
        continue;
      }
      const dtSeconds = dtMs / 1000;
      const predicted: Detection = {
        x: track.x + track.vx * dtSeconds,
        y: track.y + track.vy * dtSeconds,
        width: Math.max(1, track.width + track.vw * dtSeconds),
        height: Math.max(1, track.height + track.vh * dtSeconds),
        confidence: track.confidence * Math.exp(-this.confidenceDecayPerSecond * dtSeconds),
        class: track.classId,
        className: track.className,
        trackId: track.id,
        isPredicted: true,
      };
      results.push(applyFrameClamp(predicted, frame));
    }
    return results;
  }
}

export const createByteTrackLite = (options?: ByteTrackLiteOptions) => new ByteTrackLite(options);
