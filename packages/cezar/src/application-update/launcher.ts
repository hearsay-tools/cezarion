import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import type { RestartPlan } from './service.ts';
import type { HelperPlan } from './helper.ts';

/** Copy the helper out of the package npm will replace; pass credentials only via inherited env. */
export async function armRestartHelper(plan: RestartPlan, launch: {
  repoRoot: string; host: string; port: number; npmBin: string;
}): Promise<number> {
  const source = dirname(fileURLToPath(import.meta.url));
  const target = join(dirname(plan.recordPath), 'helper');
  assertCezarHomeWriteIsSandboxed(target);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await copyFile(join(source, 'helper.js'), join(target, 'helper.js'));
  await copyFile(join(source, 'lock.js'), join(target, 'lock.js'));
  await copyFile(join(source, 'npm-process.js'), join(target, 'npm-process.js'));
  await copyFile(join(source, 'bin-recovery.js'), join(target, 'bin-recovery.js'));
  await writeFile(join(target, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  const child = spawn(process.execPath, [join(target, 'helper.js'), '--application-update-helper'], {
    cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  if (!child.pid) throw new Error('restart helper did not start');
  const message: HelperPlan = {
    ...plan, oldPid: process.pid, nodeExecutable: process.execPath, nodeArgs: process.execArgv,
    cliArgs: process.argv.slice(2), cwd: process.cwd(), repoRoot: launch.repoRoot,
    host: launch.host, port: launch.port, npmBin: launch.npmBin,
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.kill('SIGTERM');
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('restart helper did not acknowledge')), 35_000);
    child.once('error', (error) => fail(error));
    child.once('exit', () => fail(new Error('restart helper exited before acknowledgement')));
    child.on('message', (response) => {
      if ((response as { type?: string })?.type !== 'armed' || settled) return;
      settled = true; clearTimeout(timer); child.unref(); resolve();
    });
    child.send(message, (error) => { if (error) fail(error); });
  });
  return child.pid;
}
