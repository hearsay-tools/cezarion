#!/usr/bin/env node
// A real app-server process that receives initialize but never replies. The
// file is a test-only readiness barrier; no provider events or turns are sent.
import { renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

process.on('SIGTERM', () => process.exit(143));
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    // Published atomically: the test reads a whole pid, never an empty file (hearsay-tools/cezarion#953).
    writeFileSync('.codex-startup-ready.tmp', String(process.pid));
    renameSync('.codex-startup-ready.tmp', '.codex-startup-ready');
  }
});
