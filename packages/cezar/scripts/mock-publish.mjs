import { renameSync, writeFileSync } from 'node:fs';

// A polled path exposes a complete value only: write a sibling, then rename it.
export function publishFile(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value);
  renameSync(tmp, path);
}
