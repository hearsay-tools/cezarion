import { afterEach, expect, it, vi } from 'vitest';
import type { CiWait, CiPrIdentity } from '@open-mercato/cezar-contract';
import { CiWatcherSupervisor } from './supervisor.ts';
import { CiGithubError, GithubCiClient, type GithubCheck } from './github.ts';
// Vitest does not virtualize node:timers/promises; retain AbortSignal semantics
// while putting only the timer source on the controlled clock.
vi.mock('node:timers/promises', () => ({setTimeout: (ms:number, value:unknown, options:{signal:AbortSignal}) => new Promise((resolve,reject)=>{
 const signal=options.signal;
 if(signal.aborted){reject(signal.reason);return;}
 const done=()=>{signal.removeEventListener('abort',abort);resolve(value);};
 const timer=setTimeout(done,ms);
 const abort=()=>{clearTimeout(timer);reject(signal.reason);};
 signal.addEventListener('abort',abort,{once:true});
})}));
const identity: CiPrIdentity = {prUrl:'https://github.com/org/repo/pull/12',repository:'org/repo',prNumber:12,headSha:'a'.repeat(40)};
const wait = (seconds = 1800): CiWait => ({...identity,id:crypto.randomUUID(),generation:'g',turnId:'t',timeoutSeconds:seconds,until:'checks',wakeOnConflict:true,registeredAt:new Date().toISOString(),deadline:new Date(Date.now()+seconds*1000).toISOString(),phase:'registered'});
const controllers: AbortController[]=[];
const services: CiWatcherSupervisor[]=[];
function start(github: GithubCiClient, seconds=1800) {const s=new CiWatcherSupervisor({github});services.push(s);const c=new AbortController();controllers.push(c);return {service:s,controller:c,result:s.watch(wait(seconds),c.signal)};}
class ScriptedGithub extends GithubCiClient {
 headReads=0; snapshots=0; watchers=0; active=0; peak=0; failures=0; changedAt=Infinity;
 workflowActive=false;
 override async hasActiveRuns():Promise<boolean> {return this.workflowActive;}
 mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' = 'MERGEABLE'; conflictAt=Infinity;
 rows: GithubCheck[]=[];
 override async metadata() { const headSha = await this.head(); return {headSha, mergeable: this.headReads >= this.conflictAt ? 'CONFLICTING' as const : this.mergeable, mergeStateStatus: 'DIRTY'}; }
 override async head():Promise<string> {this.headReads++; if(this.failures-->0) throw new CiGithubError('command_failed','Service unavailable',true);return this.headReads>=this.changedAt?'b'.repeat(40):identity.headSha;}
 override async checks():Promise<GithubCheck[]> {this.snapshots++;return this.rows;}
 override async watch(_pr:CiPrIdentity,signal:AbortSignal):Promise<void> {this.watchers++;this.active++;this.peak=Math.max(this.peak,this.active);try{await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}finally{this.active--;}}
}
afterEach(()=>{for(const s of services.splice(0))s.close();for(const c of controllers.splice(0))c.abort();vi.useRealTimers();});
it('keeps a partial green snapshot pending until the hidden rerun checks return and finish',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();
 github.rows=[{name:'other workflow',state:'SUCCESS',bucket:'pass',link:''}];github.workflowActive=true;
 const started=start(github);let settled=false;void started.result.then(()=>{settled=true;});
 await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(false);
 // The rerun has restored its check but has not completed it yet.
 github.rows=[...github.rows,{name:'review rerun',state:'PENDING',bucket:'pending',link:''}];
 await vi.advanceTimersByTimeAsync(30_000);expect(settled).toBe(false);
 github.workflowActive=false;github.rows[1]={name:'review rerun',state:'SUCCESS',bucket:'pass',link:''};
 await vi.advanceTimersByTimeAsync(30_000);
 expect(await started.result).toMatchObject({outcome:'passed',totalChecks:2});
});
it('does not report no_checks while a workflow is active beyond discovery',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.workflowActive=true;
 const started=start(github);let settled=false;void started.result.then(()=>{settled=true;});
 await vi.advanceTimersByTimeAsync(90_000);expect(settled).toBe(false);
 github.workflowActive=false;
 await vi.advanceTimersByTimeAsync(30_000);expect((await started.result).outcome).toBe('no_checks');
});
it.each(['pass','fail','cancel','skipping'] as const)('defers the %s check outcome while a workflow is active and retains cancellation',async bucket=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.workflowActive=true;
 github.rows=[{name:'other workflow',state:bucket,bucket,link:''}];
 const started=start(github);let settled=false;void started.result.then(()=>{settled=true;});
 await vi.advanceTimersByTimeAsync(60_000);expect(settled).toBe(false);
 started.controller.abort();expect((await started.result).outcome).toBe('cancelled');
});
it('retains the original deadline while a hidden rerun stays active',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.workflowActive=true;
 github.rows=[{name:'other workflow',state:'SUCCESS',bucket:'pass',link:''}];
 const deadline=new AbortController();const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValueOnce(deadline.signal);
 const started=start(github);timeout.mockRestore();
 await vi.advanceTimersByTimeAsync(30_000);deadline.abort();
 expect(await started.result).toMatchObject({outcome:'deadline',totalChecks:1});
});
it('detects a changed head while a hidden rerun stays active',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.workflowActive=true;github.changedAt=3;
 const started=start(github);await vi.advanceTimersByTimeAsync(30_000);
 expect(await started.result).toMatchObject({outcome:'head_changed',observedHeadSha:'b'.repeat(40)});
});
it('never turns workflow-query failure into a partial green result',async()=>{
 const github=new ScriptedGithub();github.rows=[{name:'other workflow',state:'SUCCESS',bucket:'pass',link:''}];
 github.hasActiveRuns=async()=>{throw new CiGithubError('authentication','GitHub authentication failed');};
 expect(await start(github).result).toMatchObject({outcome:'error',diagnostic:'authentication: GitHub authentication failed'});
});
it('discovers absent checks for sixty seconds at a thirty-second interval and never reports them as passing',async()=>{
 vi.useFakeTimers(); const github=new ScriptedGithub(); const {result}=start(github);
 await vi.advanceTimersByTimeAsync(1); expect(github.snapshots).toBe(1);
 await vi.advanceTimersByTimeAsync(10_000); expect(github.snapshots).toBe(1);
 await vi.advanceTimersByTimeAsync(20_000); expect(github.snapshots).toBe(2);
 await vi.advanceTimersByTimeAsync(30_000); expect(await result).toMatchObject({outcome:'no_checks',totalChecks:0}); expect(github.snapshots).toBe(3);
});
it('probes the PR head every thirty seconds while checks stay pending, not every ten',async()=>{
 vi.useFakeTimers(); const github=new ScriptedGithub(); github.rows=[{name:'build',state:'PENDING',bucket:'pending',link:''}];
 const started=start(github);
 await vi.advanceTimersByTimeAsync(1); expect(github.headReads).toBe(2); expect(github.watchers).toBe(1);
 await vi.advanceTimersByTimeAsync(10_000); expect(github.headReads).toBe(2);
 await vi.advanceTimersByTimeAsync(20_000); expect(github.headReads).toBe(3);
 started.controller.abort(); expect((await started.result).outcome).toBe('cancelled');
});
it('rechecks a stale watch completion after thirty seconds, not ten',async()=>{
 vi.useFakeTimers(); const github=new ScriptedGithub(); github.rows=[{name:'build',state:'PENDING',bucket:'pending',link:''}];
 github.watch=async()=>{github.watchers++;};
 const started=start(github);
 await vi.advanceTimersByTimeAsync(1); expect(github.snapshots).toBe(2); expect(github.watchers).toBe(1);
 await vi.advanceTimersByTimeAsync(10_000); expect(github.snapshots).toBe(2);
 await vi.advanceTimersByTimeAsync(20_000); expect(github.snapshots).toBe(4);
 started.controller.abort(); expect((await started.result).outcome).toBe('cancelled');
});
it('retries three transient failures with 1/5/15 second backoff without model wakes',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.failures=3;github.rows=[{name:'build',state:'SUCCESS',bucket:'pass',link:''}];const {result}=start(github);
 await vi.advanceTimersByTimeAsync(999);expect(github.headReads).toBe(1);
 await vi.advanceTimersByTimeAsync(1);expect(github.headReads).toBe(2);
 await vi.advanceTimersByTimeAsync(5000);expect(github.headReads).toBe(3);
 await vi.advanceTimersByTimeAsync(15000);expect((await result).outcome).toBe('passed');
});
it.each(['command_failed', 'query_timeout'] as const)('retries %s beyond three failures at a capped interval until the deadline', async code => {
 vi.useFakeTimers(); const github=new ScriptedGithub();
 github.head=async()=>{github.headReads++;throw new CiGithubError(code,`failure ${github.headReads}`);};
 const deadline=new AbortController();const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValueOnce(deadline.signal);
 const started=start(github,120);timeout.mockRestore();let settled=false;void started.result.then(()=>{settled=true;});
 await vi.advanceTimersByTimeAsync(21_000);expect(settled).toBe(false);expect(github.headReads).toBe(4);
 await vi.advanceTimersByTimeAsync(29_999);expect(github.headReads).toBe(4);
 await vi.advanceTimersByTimeAsync(1);expect(github.headReads).toBe(5);
 await vi.advanceTimersByTimeAsync(30_000);expect(github.headReads).toBe(6);
 deadline.abort();
 expect(await started.result).toMatchObject({outcome:'deadline',diagnostic:`${code}: failure 6`});
});
it('recovers an unrecognized command failure and resolves the actual verdict',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();let failed=false;
 github.hasActiveRuns=async()=>{if(!failed){failed=true;throw new CiGithubError('command_failed','Unrecognized failure');}return false;};
 github.rows=[{name:'build',state:'SUCCESS',bucket:'pass',link:''}];
 const started=start(github);await vi.advanceTimersByTimeAsync(1_000);
 expect(await started.result).toMatchObject({outcome:'passed',totalChecks:1});
 expect((await started.result).diagnostic).toBeUndefined();
});
it.each(['authentication','inaccessible_pr','gh_missing','malformed_data','output_limit'] as const)('ends %s errors immediately even if marked transient',async code=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.hasActiveRuns=async()=>{throw new CiGithubError(code,'Permanent failure',true);};
 const started=start(github);let settled=false;void started.result.then(()=>{settled=true;});
 await vi.advanceTimersByTimeAsync(0);expect(settled).toBe(true);
 expect(await started.result).toMatchObject({outcome:'error',diagnostic:`${code}: Permanent failure`});
});
it('cancels during retry backoff without reporting a deadline diagnostic',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.failures=99;
 const started=start(github);await vi.advanceTimersByTimeAsync(21_000);started.controller.abort();
 const result=await started.result;expect(result.outcome).toBe('cancelled');expect(result.diagnostic).toBeUndefined();
});
it('clears an earlier failure after a successful pending snapshot and resets backoff',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.failures=3;github.workflowActive=true;
 const deadline=new AbortController();const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValueOnce(deadline.signal);
 const started=start(github);timeout.mockRestore();await vi.advanceTimersByTimeAsync(21_000);
 github.failures=1;await vi.advanceTimersByTimeAsync(30_000);const reads=github.headReads;
 await vi.advanceTimersByTimeAsync(999);expect(github.headReads).toBe(reads);
 await vi.advanceTimersByTimeAsync(1);expect(github.headReads).toBe(reads+2);
 deadline.abort();const result=await started.result;expect(result.outcome).toBe('deadline');expect(result.diagnostic).toBeUndefined();
});
it('rejects head changes during snapshot attribution and during a running watch',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.rows=[{name:'build',state:'PENDING',bucket:'pending',link:''}];github.changedAt=3;
 const {result}=start(github);await vi.advanceTimersByTimeAsync(30_000);expect(await result).toMatchObject({outcome:'head_changed',observedHeadSha:'b'.repeat(40)});expect(github.active).toBe(0);
 const racing=new ScriptedGithub();racing.rows=[{name:'build',state:'SUCCESS',bucket:'pass',link:''}];racing.changedAt=2;expect((await start(racing).result).outcome).toBe('head_changed');
});
it('keeps at most four watchers and starts the fifth only after an owned watcher exits',async()=>{
 const github=new ScriptedGithub();github.rows=[{name:'build',state:'PENDING',bucket:'pending',link:''}];const s=new CiWatcherSupervisor({github});services.push(s);
 const cs=Array.from({length:5},()=>new AbortController());controllers.push(...cs);const pending=cs.map(c=>s.watch(wait(),c.signal));
 await vi.waitFor(()=>expect(github.active).toBe(4));cs[0]!.abort();await pending[0];await vi.waitFor(()=>expect(github.watchers).toBe(5));expect(github.peak).toBe(4);s.close();expect((await Promise.all(pending)).every(r=>r.outcome==='cancelled')).toBe(true);
});
it('does not create two watchers for one wait identity',async()=>{
 const github=new ScriptedGithub();github.rows=[{name:'build',state:'PENDING',bucket:'pending',link:''}];const s=new CiWatcherSupervisor({github});services.push(s);const c=new AbortController();const w=wait();const a=s.watch(w,c.signal),b=s.watch(w,c.signal);expect(a).toBe(b);await vi.waitFor(()=>expect(github.active).toBe(1));c.abort();await a;
});
it('reports mixed outcomes with failure before cancellation before passing checks',async()=>{
 for(const [buckets,want] of [[['pass','skipping'],'passed'],[['skipping','cancel'],'cancelled'],[['cancel','fail'],'failed']] as const){const github=new ScriptedGithub();github.rows=buckets.map(bucket=>({name:'build',state:bucket,link:'',bucket}));expect((await start(github).result).outcome).toBe(want);}
});

it('expires a queued wait on its original deadline without starting a fifth watcher',async()=>{
 const github=new ScriptedGithub();github.rows=[{name:'build',state:'PENDING',bucket:'pending',link:''}];const s=new CiWatcherSupervisor({github});services.push(s);
 const c=new AbortController();controllers.push(c);const first=Array.from({length:4},()=>s.watch(wait(),c.signal));await vi.waitFor(()=>expect(github.active).toBe(4));
 expect((await s.watch(wait(1),c.signal)).outcome).toBe('deadline');expect(github.watchers).toBe(4);c.abort();await Promise.all(first);
});
it('sanitizes external names, control sequences and credential-bearing links',async()=>{
 const github=new ScriptedGithub();github.rows=[{name:'\x1b[31mbuild\x1b[0m\x00',state:'SUCCESS',bucket:'pass',link:'https://user:password@example.com/check?token=secret'}];
 expect(await start(github).result).toMatchObject({outcome:'passed',truncated:true,checks:[{name:'build',state:'SUCCESS',link:''}]});
});

it('resolves a same-head conflict during a pending watch and reaps it at the existing probe', async () => {
 vi.useFakeTimers(); const github = new ScriptedGithub(); github.conflictAt = 3;
 github.rows = [{name:'build',state:'PENDING',bucket:'pending',link:''}];
 const started = start(github);
 await vi.advanceTimersByTimeAsync(1); expect(github.active).toBe(1);
 await vi.advanceTimersByTimeAsync(29_999);
 // A deadline guard keeps the pre-fix test finite: without conflict detection it cancels.
 const observed = started.result; started.controller.abort();
 expect(await observed).toMatchObject({outcome:'conflicting',mergeable:'CONFLICTING',mergeStateStatus:'DIRTY',headSha:identity.headSha});
 expect(github.active).toBe(0); expect(github.headReads).toBe(3);
});
it.each(['MERGEABLE', 'UNKNOWN'] as const)('does not treat advisory DIRTY with %s as a conflict', async mergeable => {
 vi.useFakeTimers(); const github = new ScriptedGithub(); github.mergeable = mergeable;
 github.rows = [{name:'build',state:'PENDING',bucket:'pending',link:''}];
 const started = start(github); await vi.advanceTimersByTimeAsync(30_000);
 expect(github.active).toBe(1); started.controller.abort();
 expect(await started.result).toMatchObject({outcome:'cancelled',mergeable,mergeStateStatus:'DIRTY'});
});
it('uses final snapshot metadata rather than an earlier conflict and retains ordinary passing behavior', async () => {
 const github = new ScriptedGithub();
 github.metadata = async () => ({headSha: await github.head(), mergeable: github.headReads === 1 ? 'CONFLICTING' : 'UNKNOWN', mergeStateStatus:'UNKNOWN'});
 github.rows = [{name:'build',state:'SUCCESS',bucket:'pass',link:''}];
 expect(await start(github).result).toMatchObject({outcome:'passed',mergeable:'UNKNOWN'});
});
it('prefers a changed head over a conflict on the same metadata read', async () => {
 const github = new ScriptedGithub(); github.changedAt=2; github.conflictAt=2;
 github.rows = [{name:'build',state:'SUCCESS',bucket:'pass',link:''}];
 expect(await start(github).result).toMatchObject({outcome:'head_changed',mergeable:'CONFLICTING',observedHeadSha:'b'.repeat(40)});
});
it.each(['pass', 'fail', 'pending', 'none'] as const)('resolves an initial conflict ahead of %s checks', async bucket => {
 const github = new ScriptedGithub(); github.conflictAt=1;
 github.rows = bucket === 'none' ? [] : [{name:'build',state:bucket,bucket,link:''}];
 const started = start(github);
 // Advance through the initial snapshot without waiting for the pre-fix deadline.
 await new Promise<void>(resolve => setImmediate(resolve)); started.controller.abort();
 expect(await started.result).toMatchObject({outcome:'conflicting',mergeable:'CONFLICTING',totalChecks:github.rows.length});
});
