import { spawn as watchdogSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
// Publish a pid atomically: readers never see an empty file whose Number() is 0
// (hearsay-tools/cezarion#953).
import { publishFile as writePid } from './mock-publish.mjs';

export function stall(prompt, { closeInput } = {}) {
  if (!prompt.includes('mock:no-progress')) return false;
  if (prompt.includes('input-closed')) {
    if (!closeInput) {
      process.stderr.write(`${process.argv[1]}: input-closed stall is unsupported\n`);
      process.exit(1);
    }
    closeInput();
    writePid('input-closed.pid', String(process.pid));
    // The S29 acknowledgement gate keeps the native pipe closed while the test
    // releases the initial prompt ACK. All other fixtures retain their exit.
    setTimeout(() => process.exit(0), prompt.includes('mock:gate-prompt-ack') ? 15_000 : 300);
  }
  if (prompt.includes('ignore-term')) {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {
      // Receipt for tests: this handler ran and returned. The default action, or a handler
      // that exits, never writes it.
      try { writePid('sigterm-ignored.pid', String(process.pid)); } catch { /* the test removed cwd */ }
    });
    // Test-cleanup backstop, deliberately longer than the asserted teardown bound.
    setTimeout(() => process.exit(0), 12_000);
  }
  if (prompt.includes('held-pipe')) {
    watchdogSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', process.stdout, process.stderr] });
  }
  if (prompt.includes('leftover')) {
    // hearsay-tools/cezarion#890: one child stays in the session's process group and ignores
    // SIGTERM; one leaves the group with setsid. Both exit on their own as a cleanup backstop.
    const leftover = (file) => `process.on('SIGTERM',()=>{}); const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${file}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${file}.tmp`)}, ${JSON.stringify(file)}); setTimeout(()=>{},20000)`;
    watchdogSpawn(process.execPath, ['-e', leftover('leftover-group.pid')], { stdio: 'ignore' });
    watchdogSpawn(process.execPath, ['-e', leftover('leftover-session.pid')], { stdio: 'ignore', detached: true }).unref();
  }
  // Publish readiness after mode setup: another process may signal us as soon as it sees it.
  writePid('watchdog.pid', String(process.pid));
  return true;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export async function waitForRelease(fallbackMs, suffix = '') {
  const release = process.env.CEZ_MOCK_RELEASE_FILE;
  const file = release && `${release}${suffix}`;
  if (!file) { if (fallbackMs) await sleep(fallbackMs); return; }
  const deadline = Date.now() + 15_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error('CEZ_MOCK_RELEASE_FILE was not created');
    await sleep(10);
  }
}
