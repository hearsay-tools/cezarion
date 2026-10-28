// Native diagnostic only. Creates its own fixture; accepts no path or arguments.
import { mkdtempSync, mkdirSync, chmodSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.argv.length !== 2) throw Error('Run on macOS with no arguments');
const probe = fileURLToPath(new URL('./macos-jxa-parent-probe.js', import.meta.url));
const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-jxa-probe-'));
const names = ["zero ' $() \\ \n é", "bits ' $() \\ \n é"];
const matches = (before, after, a, b, width) => {
  const one = Buffer.alloc(width), two = Buffer.alloc(width);
  if (width === 8) { one.writeBigUInt64LE(BigInt.asUintN(64, a)); two.writeBigUInt64LE(BigInt.asUintN(64, b)); }
  else if (width === 4) { one.writeUInt32LE(Number(BigInt.asUintN(32, a))); two.writeUInt32LE(Number(BigInt.asUintN(32, b))); }
  else { one.writeUInt16LE(Number(BigInt.asUintN(16, a))); two.writeUInt16LE(Number(BigInt.asUintN(16, b))); }
  const offsets = [];
  for (let i = 0; i <= before.length - width; i++) {
    if (before.subarray(i, i + width).equals(one) && after.subarray(i, i + width).equals(two)) offsets.push(i);
  }
  return offsets;
};
try {
 for (const [index, name] of names.entries()) {
  const child = join(root, name);
  mkdirSync(child, { mode: 0o700 });
  chmodSync(child, index === 0 ? 0o000 : 0o050);
  const before = lstatSync(child, { bigint: true });
  const targetMode = Number(before.mode & 0o7777n) | 0o700;
  const run = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', probe, root, name, targetMode.toString(8)], { encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 });
  console.log(JSON.stringify({ exit: run.status, signal: run.signal, error: run.error?.message, stdout: run.stdout, stderr: run.stderr }));
  if (run.error || run.status !== 0) throw Error('osascript failed');
  const result = JSON.parse(run.stdout);
  if (result.argv?.[0] !== root || result.argv?.[1] !== name || result.argv?.[2] !== targetMode.toString(8)) throw Error('argv mismatch');
  if (result.fd < 0 || result.before !== 0 || result.chmod !== 0 || result.after !== 0) throw Error('native syscall failed');
  const after = lstatSync(child, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || (after.mode & 0o7777n) !== BigInt(targetMode)) throw Error('identity or mode mismatch');
  const first = Buffer.from(result.beforeStatBytes, 'base64');
  const last = Buffer.from(result.afterStatBytes, 'base64');
  if (first.length !== 512 || last.length !== 512) throw Error('invalid stat buffer');
  const offsets = {
    device32: matches(first, last, before.dev, after.dev, 4),
    inode64: matches(first, last, before.ino, after.ino, 8),
    mode16: matches(first, last, before.mode, after.mode, 2),
  };
  console.log(JSON.stringify({ before: { dev: String(before.dev), ino: String(before.ino), mode: before.mode.toString(8) }, after: { dev: String(after.dev), ino: String(after.ino), mode: after.mode.toString(8) }, offsets }));
  if (Object.values(offsets).some((x) => x.length !== 1)) throw Error('raw stat identity is not uniquely identified; no ABI assumption accepted');
 }
} finally {
  // This path was created by this process. Never accept a workspace path.
  for (const name of names) {
    try { chmodSync(join(root, name), 0o700); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  rmSync(root, { recursive: true, force: true });
}
