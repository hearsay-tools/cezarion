import { LIVE_BYTE_LIMIT, type RunEvent } from '@open-mercato/cezar-contract';

// A store-wide bound, including items whose runner never emitted completion.
const MAX_ITEMS = 256;
const MAX_BYTES = 4 * LIVE_BYTE_LIMIT;
type Entry = { runId: string; event: RunEvent; bytes: number; ephemeral: boolean };

/** Latest active item state for finite HTTP readers. No raw delta log or disk writes.
 * Eviction drops an entire item: never append a suffix to a missing text prefix. A
 * later full snapshot can seed it again; persisted completion always remains replayable. */
export class LiveItemSnapshots {
  private readonly items = new Map<string, Entry>();
  private bytes = 0;

  observe(runId: string, event: RunEvent, ephemeral: boolean): void {
    if (event.type === 'session.started' || event.type === 'session.ended') {
      for (const [key, entry] of this.items) {
        if (entry.runId === runId && entry.event.stepId === event.stepId) this.remove(key);
      }
      return;
    }
    const item = event.item;
    const id = event.type === 'item.delta' ? event.itemId :
      item && typeof item === 'object' && 'id' in item ? item.id : undefined;
    if (typeof id !== 'string') return;
    const key = JSON.stringify([runId, event.stepId, id]);
    if (event.type === 'item.completed') { this.remove(key); return; }
    let snapshot: RunEvent;
    if (event.type === 'item.delta') {
      const prior = this.items.get(key)?.event;
      const previous = prior?.item;
      if (!prior || !previous || typeof previous !== 'object' || !('kind' in previous) || typeof event.delta !== 'string') return;
      const field = previous.kind === 'tool' && event.field === 'output' ? 'output' :
        previous.kind !== 'tool' && (event.field === 'text' || event.field === 'reasoning') ? 'text' : undefined;
      if (!field) return;
      const text = field in previous ? (previous as Record<string, unknown>)[field] : '';
      snapshot = { ...prior, type: 'item.updated', seq: event.seq, ts: event.ts,
        item: { ...previous, [field]: (typeof text === 'string' ? text : '') + event.delta } };
    } else if (event.type === 'item.started' || event.type === 'item.updated') {
      if (!item || typeof item !== 'object' || !('kind' in item) ||
        !['message', 'reasoning', 'tool'].includes(String(item.kind))) return;
      snapshot = event;
    } else return;
    this.remove(key);
    const bytes = Buffer.byteLength(JSON.stringify(snapshot)) + 1;
    // An individually oversized active item waits for the existing history recovery path.
    if (bytes > LIVE_BYTE_LIMIT) return;
    while (this.items.size >= MAX_ITEMS || this.bytes + bytes > MAX_BYTES) this.remove(this.items.keys().next().value!);
    this.items.set(key, { runId, event: structuredClone(snapshot), bytes, ephemeral });
    this.bytes += bytes;
  }

  read(runId: string): RunEvent[] {
    return [...this.items.values()].filter(entry => entry.runId === runId && entry.ephemeral)
      .map(entry => entry.event).sort((a, b) => a.seq - b.seq);
  }

  forget(runId: string): void {
    for (const [key, entry] of this.items) if (entry.runId === runId) this.remove(key);
  }

  clear(): void { this.items.clear(); this.bytes = 0; }

  private remove(key: string): void {
    const entry = this.items.get(key);
    if (entry) { this.bytes -= entry.bytes; this.items.delete(key); }
  }
}
