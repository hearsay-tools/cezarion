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
const wait = (seconds = 1800): CiWait => ({...identity,id:crypto.randomUUID(),generation:'g',turnId:'t',timeoutSeconds:seconds,registeredAt:new Date().toISOString(),deadline:new Date(Date.now()+seconds*1000).toISOString(),phase:'registered'});
const controllers: AbortController[]=[];
const services: CiWatcherSupervisor[]=[];
function start(github: GithubCiClient, seconds=1800) {const s=new CiWatcherSupervisor({github});services.push(s);const c=new AbortController();controllers.push(c);return {service:s,controller:c,result:s.watch(wait(seconds),c.signal)};}
class ScriptedGithub extends GithubCiClient {
 headReads=0; snapshots=0; watchers=0; active=0; peak=0; failures=0; changedAt=Infinity;
 rows: GithubCheck[]=[];
 override async head():Promise<string> {this.headReads++; if(this.failures-->0) throw new CiGithubError('command_failed','Service unavailable',true);return this.headReads>=this.changedAt?'b'.repeat(40):identity.headSha;}
 override async checks():Promise<GithubCheck[]> {this.snapshots++;return this.rows;}
 override async watch(_pr:CiPrIdentity,signal:AbortSignal):Promise<void> {this.watchers++;this.active++;this.peak=Math.max(this.peak,this.active);try{await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}finally{this.active--;}}
}
afterEach(()=>{for(const s of services.splice(0))s.close();for(const c of controllers.splice(0))c.abort();vi.useRealTimers();});
it('discovers absent checks for sixty seconds and never reports them as passing',async()=>{
 vi.useFakeTimers(); const github=new ScriptedGithub(); const {result}=start(github);
 await vi.advanceTimersByTimeAsync(60000); expect(await result).toMatchObject({outcome:'no_checks',totalChecks:0});expect(github.snapshots).toBe(7);
});
it('retries three transient failures with 1/5/15 second backoff without model wakes',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.failures=3;github.rows=[{name:'build',state:'SUCCESS',bucket:'pass',link:''}];const {result}=start(github);
 await vi.advanceTimersByTimeAsync(999);expect(github.headReads).toBe(1);
 await vi.advanceTimersByTimeAsync(1);expect(github.headReads).toBe(2);
 await vi.advanceTimersByTimeAsync(5000);expect(github.headReads).toBe(3);
 await vi.advanceTimersByTimeAsync(15000);expect((await result).outcome).toBe('passed');
});
it('settles persistent transient errors after the third retry',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.failures=99;const {result}=start(github);await vi.advanceTimersByTimeAsync(21000);expect((await result).outcome).toBe('error');expect(github.headReads).toBe(4);
});
it('rejects head changes during snapshot attribution and during a running watch',async()=>{
 vi.useFakeTimers();const github=new ScriptedGithub();github.rows=[{name:'build',state:'PENDING',bucket:'pending',link:''}];github.changedAt=3;
 const {result}=start(github);await vi.advanceTimersByTimeAsync(10000);expect(await result).toMatchObject({outcome:'head_changed',observedHeadSha:'b'.repeat(40)});expect(github.active).toBe(0);
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
it('reports mixed outcomes with failure before cancellation before skips',async()=>{
 for(const [buckets,want] of [[['pass','skipping'],'skipped'],[['skipping','cancel'],'cancelled'],[['cancel','fail'],'failed']] as const){const github=new ScriptedGithub();github.rows=buckets.map(bucket=>({name:'build',state:bucket,link:'',bucket}));expect((await start(github).result).outcome).toBe(want);}
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
