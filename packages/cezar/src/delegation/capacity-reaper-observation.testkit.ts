import { types } from 'node:util';
import { AliasBudgetExceeded } from './linux-alias-model.ts';

type Outcome = 'fulfilled' | 'budget-rejected' | 'other-rejected' | 'sync-throw' | 'incomplete' | 'unsupported' | 'diagnostic-failed';
type SpyResult = { type: string; value?: unknown };

/** Observe existing spy results without waiting for a pending operation. */
export async function observeReapers(results: readonly SpyResult[], write: (line: string) => void): Promise<void> {
  try {
    const total = results.length;
    const labels: Outcome[] = [];
    for (const result of results.slice(0, 16)) {
      const index = labels.length;
      labels.push('unsupported');
      if (result.type === 'throw') labels[index] = 'sync-throw';
      else if (result.type === 'incomplete') labels[index] = 'incomplete';
      else if (result.type === 'return' && types.isPromise(result.value)) {
        Promise.prototype.then.call(result.value,
          () => { try { labels[index] = 'fulfilled'; } catch { /* diagnostic only */ } },
          (error: unknown) => {
            try { labels[index] = error instanceof AliasBudgetExceeded ? 'budget-rejected' : 'other-rejected'; }
            catch { try { labels[index] = 'diagnostic-failed'; } catch { /* diagnostic only */ } }
          });
      }
    }
    await Promise.resolve();
    const snapshot = labels.slice();
    write(`capacity reapers: total=${total} outcomes=${snapshot.join(',')} omitted=${total > 16 ? 'yes' : 'no'}\n`);
  } catch {
    try { write('capacity reapers: diagnostic-failed\n'); } catch { /* preserve the fixture verdict */ }
  }
}
