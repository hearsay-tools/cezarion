import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { CiGithubError, GithubCiClient } from '../ci-wait/github.ts';
import { manager, store, root, restart, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { ciNativeMessages } from './waits-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// Control only the initial retry delay, retaining abort behavior and native
// runner processes. Releasing the delay represents its one-second backoff.
const probes = vi.hoisted(() => new Set<{ resume(): void }>());
vi.mock('node:timers/promises', async importOriginal => {
 const actual = await importOriginal<typeof import('node:timers/promises')>();
 return {...actual,setTimeout: (ms: number, value: unknown, options?: {signal?: AbortSignal}) => {
  if (ms !== 1_000) return actual.setTimeout(ms,value,options);
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

describe('CI query retries across native harnesses', {timeout:30_000},()=>{
 useWorkerWaitFixture();
 for(const runner of RUNNER_IDS) for(const recovered of [false,true]) {
  it(`${runner} R92 ${recovered?'recovered without a session':'fresh'} retains a failed query until the CI verdict`,async()=>{
   process.env.CEZ_DRY_RUN='0';
   process.env[HARNESS_ADAPTERS[runner].binEnv]=HARNESS_ADAPTERS[runner].mockBin;
   process.env.CEZ_MOCK_ARGS_FILE=join(root,'args');process.env.CEZ_MOCK_STDIN_FILE=join(root,'stdin');
   const state=join(root,'rerun-state');writeFileSync(state,'complete');
   const github=new GithubCiClient({command:{file:process.execPath,args:[fixture]},env:{...process.env,CI_FIXTURE_RERUN_STATE:state}});
   const checks=github.checks.bind(github),runs=github.hasActiveRuns.bind(github);
   const resolve=github.resolve.bind(github),metadata=github.metadata.bind(github);
   const resolveSpy=vi.spyOn(GithubCiClient.prototype,'resolve').mockImplementation(resolve);
   const metadataSpy=vi.spyOn(GithubCiClient.prototype,'metadata').mockImplementation(metadata);
   const checksSpy=vi.spyOn(GithubCiClient.prototype,'checks').mockImplementation(checks);
   let failing=true;
   const runsSpy=vi.spyOn(GithubCiClient.prototype,'hasActiveRuns').mockImplementation(async (...args)=>{
    if(failing)throw new CiGithubError('command_failed','Unrecognized query failure');
    return runs(...args);
   });
   try {
    const run=manager.startRun(QUICK_TASK_WORKFLOW,{task:HARNESS_ADAPTERS[runner].scenarios.baseline!,runner});
    await until(()=>store.getRun(run.id)?.status==='waiting');
    const engine=manager as unknown as {active:Map<string,{ciGeneration:string}>};
    await manager.registerWait(run.id,{kind:'pr',pr:'https://github.com/org/repo/pull/12',timeout_seconds:120},'cezar_wait',engine.active.get(run.id)!.ciGeneration);
    await until(()=>probes.size===1 || !!lastWaitOf(run.id)?.deliveredAt);
    expect(lastWaitOf(run.id)).toBeUndefined();
    await until(()=>ciWaitOf(run.id)?.phase==='open' && store.getRun(run.id)?.status==='waiting');
    const id=ciWaitOf(run.id)!.id;
    if(recovered){await restart();await until(()=>probes.size===1);expect(manager.isActive(run.id)).toBe(false);}
    expect(ciWaitOf(run.id)).toMatchObject({id,phase:'open'});
    expect(store.getRun(run.id)?.agentInputs?.some(input=>input.id===id)).toBeFalsy();
    // Query failure must not create an input or spend a model turn. Release
    // the real supervisor backoff only after inspecting the durable open wait.
    failing=false;for(const probe of probes)probe.resume();
    await until(()=>!!lastWaitOf(run.id)?.deliveredAt);
    expect(lastWaitOf(run.id)).toMatchObject({id,result:{outcome:'passed',totalChecks:2}});
    expect(store.getRun(run.id)?.agentInputs?.filter(input=>input.id===id)).toHaveLength(1);
    await until(()=>ciNativeMessages(runner,root).some(text=>text.includes(`CI wait observation ${id}`)));
    expect(ciNativeMessages(runner,root).filter(text=>text.includes(`CI wait observation ${id}`))).toHaveLength(1);
   } finally {checksSpy.mockRestore();runsSpy.mockRestore();resolveSpy.mockRestore();metadataSpy.mockRestore();}
  });
 }
});
