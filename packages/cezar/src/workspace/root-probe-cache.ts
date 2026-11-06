import { resolve } from 'node:path';

/** Completed values and flights share a slot. Replacing a slot fences late writes. */
export function createRootProbeCache<T>({ compute, now, ttlMs }: {
  compute: (root: string) => Promise<T>;
  now: () => number;
  ttlMs: number;
}) {
  interface Slot { value?: { at: number; result: T }; flight?: Promise<T>; generation: number }
  const slots = new Map<string, Slot>();
  let epoch = 0;
  return {
    get(root: string): Promise<T> {
      const key = resolve(root);
      let slot = slots.get(key);
      if (!slot) { slot = { generation: 0 }; slots.set(key, slot); }
      if (slot.value && now() - slot.value.at < ttlMs) return Promise.resolve(slot.value.result);
      if (slot.flight) return slot.flight;
      const current = slot;
      const generation = current.generation;
      const startedEpoch = epoch;
      const valid = () => epoch === startedEpoch && slots.get(key) === current && current.generation === generation;
      const flight = Promise.resolve().then(() => compute(key)).then((result) => {
        if (valid()) current.value = { at: now(), result };
        return result;
      }).finally(() => {
        if (valid()) delete current.flight;
      });
      current.flight = flight;
      return flight;
    },
    invalidate(root: string): void {
      const key = resolve(root);
      const slot = slots.get(key);
      if (slot) slot.generation++;
      slots.delete(key);
    },
    clear(): void { epoch++; slots.clear(); },
  };
}
