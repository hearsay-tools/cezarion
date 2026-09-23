#!/usr/bin/env node
// A real app-server process that receives initialize but never replies. The
// file is a test-only readiness barrier; no provider events or turns are sent.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

process.on('SIGTERM', () => process.exit(143));
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    writeFileSync('.codex-startup-ready', String(process.pid));
  }
});
