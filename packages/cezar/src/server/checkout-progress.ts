import type { CheckoutProgressEvent } from '@open-mercato/cezar-contract';

/** Recovery cache for the clone dialog, never an authority for the mutation's result. */
export class CheckoutProgressCache {
  private readonly values = new Map<string, { at: number; progress: CheckoutProgressEvent }>();
  constructor(private readonly now = Date.now) {}
  private prune() {
    for (const [key, value] of this.values) if (this.now() - value.at >= 5 * 60_000) this.values.delete(key);
  }
  record(progress: CheckoutProgressEvent): void {
    if (!progress.checkoutId) return;
    this.prune();
    this.values.delete(progress.checkoutId);
    this.values.set(progress.checkoutId, { at: this.now(), progress: { ...progress, ...(progress.line ? { line: progress.line.slice(-4096) } : {}), ...(progress.error ? { error: progress.error.slice(-4096) } : {}) } });
    while (this.values.size > 128) this.values.delete(this.values.keys().next().value!);
  }
  get(id: string): CheckoutProgressEvent | null {
    this.prune();
    return this.values.get(id)?.progress ?? null;
  }
}
