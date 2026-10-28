import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parent-pinned chmod is only authorized for explicit worker destruction. */
export async function darwinDestroyChmod(path: string, expected?: { dev: number; ino: number }): Promise<void> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory: ${path}`);
  if (expected && (!Number.isSafeInteger(expected.dev) || !Number.isSafeInteger(expected.ino) ||
      BigInt(expected.dev) !== info.dev || BigInt(expected.ino) !== info.ino)) throw new Error(`Directory changed: ${path}`);
  const device = Buffer.alloc(4); const inode = Buffer.alloc(8);
  device.writeUInt32LE(Number(BigInt.asUintN(32, info.dev))); inode.writeBigUInt64LE(BigInt.asUintN(64, info.ino));
  const script = fileURLToPath(new URL('../../scripts/darwin-destroy-chmod.js', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', script, dirname(path), basename(path), device.toString('hex'), inode.toString('hex')],
      { timeout: 15_000, maxBuffer: 16_384 }, (error, stdout, stderr) => {
        if (error || stdout.trim() !== 'ok') reject(new Error(`Cannot repair ${path}: ${stderr.trim() || error?.message || 'invalid helper response'}`));
        else resolve();
      });
  });
  const current = await lstat(path, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino || await realpath(path) !== path) throw new Error(`Directory changed after repair: ${path}`);
}
