import type { Detection } from '@/modules/yoloUtils';

export type Snapshot = {
  id: string;
  uri: string;
  detections: Detection[];
  runAt: number;
  width: number;
  height: number;
};

const MAX_SNAPSHOTS = 20;
const snapshots: Snapshot[] = [];
const listeners = new Set<(items: Snapshot[]) => void>();

export const addSnapshot = (snapshot: Snapshot) => {
  snapshots.unshift(snapshot);
  if (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.length = MAX_SNAPSHOTS;
  }
  const copy = [...snapshots];
  listeners.forEach((listener) => listener(copy));
};

export const getSnapshots = (): Snapshot[] => [...snapshots];

export const subscribeSnapshots = (listener: (items: Snapshot[]) => void) => {
  listeners.add(listener);
  listener([...snapshots]);
  return () => {
    listeners.delete(listener);
  };
};
