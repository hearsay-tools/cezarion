// Native-wire watchdog fixtures shared by the bundled offline harnesses.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
export function watchdogStall(prompt) {
  if (!prompt.includes('mock:no-progress')) return false;
  writeFileSync('watchdog.pid', String(process.pid));
  if (prompt.includes('ignore-term')) {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {});
    // Test-cleanup backstop, deliberately longer than the asserted teardown bound.
    setTimeout(() => process.exit(0), 12_000);
  }
  if (prompt.includes('held-pipe')) {
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', process.stdout, process.stderr] });
  }
  return true;
}
