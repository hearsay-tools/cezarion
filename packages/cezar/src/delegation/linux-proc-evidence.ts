import { closeSync, openSync, readSync } from 'node:fs';
import { AliasWorkBudget } from './linux-alias-model.ts';

/** Bound bytes read from a proc file and charge them to the shared attempt. */
export function readProcEvidence(path: string, budget: AliasWorkBudget): Buffer {
  const limit = 4 * 1024 * 1024;
  const fd = openSync(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - total));
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      total += length;
      budget.spend(Math.ceil(length / 256));
      if (total > limit) throw new Error('proc evidence exceeds bounds');
      chunks.push(chunk.subarray(0, length));
    }
    return Buffer.concat(chunks);
  } finally { closeSync(fd); }
}
