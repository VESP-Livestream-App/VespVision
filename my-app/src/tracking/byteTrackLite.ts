export type Det = { x1: number; y1: number; x2: number; y2: number; score: number };

export type Track = {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  vx: number;
  vy: number;
  score: number;
  age: number;
  lost: number;
};

export const cxcywhToXyxy = (cx: number, cy: number, w: number, h: number): Det => {
  const halfW = w * 0.5;
  const halfH = h * 0.5;
  return {
    x1: cx - halfW,
    y1: cy - halfH,
    x2: cx + halfW,
    y2: cy + halfH,
    score: 1,
  };
};

const iou = (a: Det | Track, b: Det | Track): number => {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
};

export class ByteTrackLite {
  private tracks: Track[] = [];
  private nextId = 1;
  private trackThresh: number;
  private matchIouThresh: number;
  private maxLost: number;
  private smooth: number;

  constructor(trackThresh = 0.35, matchIouThresh = 0.3, maxLost = 25, smooth = 0.6) {
    this.trackThresh = trackThresh;
    this.matchIouThresh = matchIouThresh;
    this.maxLost = maxLost;
    this.smooth = smooth;
  }

  update(dets: Det[]): Track[] {
    const filtered = dets.filter((d) => d.score >= this.trackThresh);
    const tracks = this.tracks;

    // Predict forward with constant velocity (center-based).
    for (let i = 0; i < tracks.length; i += 1) {
      const t = tracks[i];
      t.age += 1;
      t.lost += 1;
      const w = t.x2 - t.x1;
      const h = t.y2 - t.y1;
      const cx = (t.x1 + t.x2) * 0.5 + t.vx;
      const cy = (t.y1 + t.y2) * 0.5 + t.vy;
      t.x1 = cx - w * 0.5;
      t.y1 = cy - h * 0.5;
      t.x2 = cx + w * 0.5;
      t.y2 = cy + h * 0.5;
    }

    if (tracks.length === 0) {
      for (let i = 0; i < filtered.length; i += 1) {
        this.tracks.push(this.createTrack(filtered[i]));
      }
      return this.sortedTracks();
    }

    const detMatched = new Array(filtered.length).fill(false);

    // Greedy matching by best IoU per track.
    for (let tIdx = 0; tIdx < tracks.length; tIdx += 1) {
      const t = tracks[tIdx];
      let bestIdx = -1;
      let bestIou = 0;
      for (let dIdx = 0; dIdx < filtered.length; dIdx += 1) {
        if (detMatched[dIdx]) {
          continue;
        }
        const score = iou(t, filtered[dIdx]);
        if (score > bestIou) {
          bestIou = score;
          bestIdx = dIdx;
        }
      }
      if (bestIdx !== -1 && bestIou >= this.matchIouThresh) {
        detMatched[bestIdx] = true;
        const det = filtered[bestIdx];
        const prevCx = (t.x1 + t.x2) * 0.5;
        const prevCy = (t.y1 + t.y2) * 0.5;

        t.x1 = this.smooth * t.x1 + (1 - this.smooth) * det.x1;
        t.y1 = this.smooth * t.y1 + (1 - this.smooth) * det.y1;
        t.x2 = this.smooth * t.x2 + (1 - this.smooth) * det.x2;
        t.y2 = this.smooth * t.y2 + (1 - this.smooth) * det.y2;

        const newCx = (t.x1 + t.x2) * 0.5;
        const newCy = (t.y1 + t.y2) * 0.5;
        const dx = newCx - prevCx;
        const dy = newCy - prevCy;
        t.vx = this.smooth * t.vx + (1 - this.smooth) * dx;
        t.vy = this.smooth * t.vy + (1 - this.smooth) * dy;
        t.score = det.score;
        t.lost = 0;
      }
    }

    // Create new tracks for unmatched detections.
    for (let dIdx = 0; dIdx < filtered.length; dIdx += 1) {
      if (!detMatched[dIdx]) {
        tracks.push(this.createTrack(filtered[dIdx]));
      }
    }

    // Drop stale tracks.
    this.tracks = tracks.filter((t) => t.lost <= this.maxLost);
    return this.sortedTracks();
  }

  private createTrack(det: Det): Track {
    return {
      id: this.nextId++,
      x1: det.x1,
      y1: det.y1,
      x2: det.x2,
      y2: det.y2,
      vx: 0,
      vy: 0,
      score: det.score,
      age: 1,
      lost: 0,
    };
  }

  private sortedTracks(): Track[] {
    return this.tracks
      .slice()
      .sort((a, b) => (a.lost - b.lost) || (b.score - a.score));
  }
}
