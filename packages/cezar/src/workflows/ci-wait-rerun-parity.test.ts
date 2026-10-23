import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { GithubCiClient } from '../ci-wait/github.ts';
import { manager, store, root, restart, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// Control only the supervisor's probe boundary, retaining abort behavior and real
// native runner processes. Releasing a probe represents its next 30-second tick.
const probes = vi.hoisted(() => new Set<{ resume(): void }>());
vi.mock('node:timers/promises', async importOriginal => {
 const actual = await importOriginal<typeof import('node:timers/promises')>();
 return {...actual,setTimeout: (ms: number, value: unknown, options?: {signal?: AbortSignal}) => {
  if (ms !== 30_000) return actual.setTimeout(ms,value,options);
  return new Promise((resolve,reject)=>{
   const signal=options?.signal;
   const cleanup=()=>{probes.delete(probe);signal?.removeEventListener('abort',abort);};
   const probe={resume:()=>{cleanup();resolve(value);}};
   const abort=()=>{cleanup();reject(signal?.reason);};
   if(signal?.aborted){reject(signal.reason);return;}
   probes.add(probe);signal?.addEventListener('abort',abort,{once:true});
  });
 }};
});
const fixture=fileURLToPath(new URL('../ci-wait/fixtures/gh.mjs',import.meta.url));
const ciWaitOf=(id:string)=>store.getRun(id)?.waits?.find(wait=>wait.kind==='pr');
const lastWaitOf=(id:string)=>store.getRun(id)?.lastWaits?.find(wait=>wait.kind==='pr');

describe('hidden CI reruns across native harnesses', {timeout:30_000},()=>{
 useWorkerWaitFixture();
 for(const runner of RUNNER_IDS) for(const recovered of [false,true]) {
  it(`${runner} R85 ${recovered?'recovered without a session':'fresh'} keeps partial green pending until rerun checks return`,async()=>{
   const state=join(root,'rerun-state');writeFileSync(state,'hidden');
   const github=new GithubCiClient({command:{file:process.execPath,args:[fixture]},env:{...process.env,CI_FIXTURE_RERUN_STATE:state}});
   const checks=github.checks.bind(github),runs=github.hasActiveRuns.bind(github);
   const checksSpy=vi.spyOn(GithubCiClient.prototype,'checks').mockImplementation(checks);
   const runsSpy=vi.spyOn(GithubCiClient.prototype,'hasActiveRuns').mockImplementation(runs);
   try {
    const run=manager.startRun(QUICK_TASK_WORKFLOW,{task:'mock:ci-wait https://github.com/org/repo/pull/12',runner});
    await until(()=>probes.size===1 || !!lastWaitOf(run.id)?.deliveredAt);
    expect(lastWaitOf(run.id)).toBeUndefined();
    await until(()=>ciWaitOf(run.id)?.phase==='open' && store.getRun(run.id)?.status==='waiting');
    const id=ciWaitOf(run.id)!.id;
    if(recovered){await restart();await until(()=>probes.size===1);expect(manager.isActive(run.id)).toBe(false);}
    expect(ciWaitOf(run.id)).toMatchObject({id,phase:'open'});
    expect(store.getRun(run.id)?.agentInputs?.some(input=>input.id===id)).toBeFalsy();
    // Restore the hidden run's checks, still pending, then finish the rerun.
    writeFileSync(state,'pending');for(const probe of probes)probe.resume();
    await until(()=>probes.size===1);
    expect(ciWaitOf(run.id)).toMatchObject({id,phase:'open'});
    expect(lastWaitOf(run.id)).toBeUndefined();
    writeFileSync(state,'complete');for(const probe of probes)probe.resume();
    await until(()=>!!lastWaitOf(run.id)?.deliveredAt);
    expect(lastWaitOf(run.id)).toMatchObject({id,result:{outcome:'passed',totalChecks:2}});
    expect(store.getRun(run.id)?.agentInputs?.filter(input=>input.id===id)).toHaveLength(1);
   } finally {checksSpy.mockRestore();runsSpy.mockRestore();}
  });
 }
});
