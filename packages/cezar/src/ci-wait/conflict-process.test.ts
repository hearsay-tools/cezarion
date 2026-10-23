import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { GithubCiClient } from './github.ts';
import { CiWatcherSupervisor } from './supervisor.ts';

// Control the supervisor probe, leaving real child processes and termination clocks intact.
const probes = vi.hoisted(() => [] as Array<() => void>);
vi.mock('node:timers/promises', () => ({setTimeout: (_ms: number, value: unknown, {signal}: {signal: AbortSignal}) => new Promise((resolve, reject) => {
 const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
 if (signal.aborted) { abort(); return; }
 signal.addEventListener('abort', abort, {once:true});
 probes.push(() => { signal.removeEventListener('abort', abort); resolve(value); });
})}));
let supervisor: CiWatcherSupervisor | undefined;
let directory: string | undefined;
afterEach(async () => { supervisor?.close(); probes.length=0; if(directory) await rm(directory,{recursive:true,force:true}); });

it('reaps the owned native watch child before returning a probe conflict', async () => {
 directory = await mkdtemp(join(tmpdir(),'ci-conflict-process-'));
 const log=join(directory,'queries'), gate=join(directory,'conflicting');
 const github = new GithubCiClient({command:{file:process.execPath,args:[fileURLToPath(new URL('./fixtures/gh.mjs',import.meta.url))]},
  env:{...process.env,CI_FIXTURE_MODE:'stubborn',CI_FIXTURE_LOG:log,CI_FIXTURE_CONFLICT_FILE:gate}});
 supervisor = new CiWatcherSupervisor({github});
 const controller = new AbortController();
 const pending = supervisor.watch({id:crypto.randomUUID(),generation:'g',turnId:'t',prUrl:'https://github.com/org/repo/pull/12',repository:'org/repo',prNumber:12,
  headSha:'a'.repeat(40),registeredAt:new Date().toISOString(),deadline:new Date(Date.now()+120_000).toISOString(),timeoutSeconds:120,until:'checks',wakeOnConflict:true,phase:'registered'},controller.signal);
 try {
  // Wait on the child-published log, not a sleep racing fixture startup under load.
  await vi.waitFor(async () => { expect(await readFile(log,'utf8')).toContain('--watch'); expect(probes.length).toBe(1); }, {timeout:20_000});
  await writeFile(gate,''); probes.shift()!();
  expect(await pending).toMatchObject({outcome:'conflicting',mergeable:'CONFLICTING',mergeStateStatus:'DIRTY'});
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {args:string[];pid:number});
  expect(calls.filter(call=>call.args.includes('--watch'))).toHaveLength(1);
  // A successful result must not release its slot while the SIGTERM-resistant child survives.
  for (const call of calls) expect(()=>process.kill(call.pid,0)).toThrow();
 } finally { controller.abort(); await pending; }
}, 35_000);
