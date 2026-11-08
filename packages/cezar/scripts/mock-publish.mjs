import { renameSync, rmSync, writeFileSync } from 'node:fs';

// A polled path exposes a complete value only: write a sibling, then rename it.
export function publishFile(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, value);
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* Preserve the publication error. */ }
    throw error;
  }
}
