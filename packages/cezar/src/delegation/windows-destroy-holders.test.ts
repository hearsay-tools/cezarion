import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reapDestroyHolders } from './destroy-holders.ts';

it.runIf(process.platform === 'win32')('stops a scoped open-file holder and preserves an unrelated process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-windows-holder-'));
  const file = join(root, 'owned'); await writeFile(file, 'data');
  const script = 'if(process.argv[1]) require("fs").openSync(process.argv[1],"r"); console.log("ready"); setInterval(()=>{},1000)';
  const holder = spawn(process.execPath, ['-e', script, file], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
  const other = spawn(process.execPath, ['-e', script], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(holder, 'exit');
  try {
    await Promise.all([holder, other].map(child => once(child.stdout!, 'data')));
    await reapDestroyHolders([root], () => {});
    await exited;
    expect(other.exitCode).toBeNull(); expect(other.signalCode).toBeNull();
  } finally {
    holder.kill(); other.kill(); await rm(root, { recursive: true, force: true });
  }
}, 120_000);
