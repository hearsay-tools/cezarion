import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnDetached, stopGroup } from '../detached-process.ts';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import type { RestartPlan } from './service.ts';
import type { HelperPlan } from './helper.ts';

/** Every module the copied helper loads, by its path from this directory in `dist`. Each copy
 *  keeps that path from `helper/`, so `../detached-process.js` lands in the state directory.
 *  `launcher.test.ts` checks the list against the helper's import closure. */
export const HELPER_MODULES = ['helper.js', 'lock.js', 'npm-process.js', 'bin-recovery.js', '../detached-process.js'] as const;

/** Copy the helper out of the package npm will replace; pass credentials only via inherited env. */
export async function armRestartHelper(plan: RestartPlan, launch: {
  repoRoot: string; host: string; port: number; npmBin: string;
}): Promise<number> {
  const source = dirname(fileURLToPath(import.meta.url));
  const target = join(dirname(plan.recordPath), 'helper');
  assertCezarHomeWriteIsSandboxed(target);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const module of HELPER_MODULES) await copyFile(join(source, module), join(target, module));
  // Every directory a copy lands in gets the marker that makes its modules ES modules.
  for (const dir of new Set(HELPER_MODULES.map((module) => dirname(join(target, module))))) {
    await writeFile(join(dir, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  }
  const child = spawnDetached(process.execPath, [join(target, 'helper.js'), '--application-update-helper'], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const pid = child.pid;
  if (!pid) throw new Error('restart helper did not start');
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
      // The helper and whatever it forked go before the reject, so a retry never meets them.
      void stopGroup({ pid, child }, { graceMs: 3_000, killWaitMs: 3_000 }).catch(() => false).then(() => reject(error));
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
  return pid;
}
