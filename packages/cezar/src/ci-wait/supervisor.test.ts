import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CiWait } from '@open-mercato/cezar-contract';
import { CiWatcherSupervisor } from './supervisor.ts';
import { GithubCiClient } from './github.ts';
const fixture = fileURLToPath(new URL('./fixtures/gh.mjs', import.meta.url));
const supervisors: CiWatcherSupervisor[] = [];
const dirs: string[] = [];
const wait = (seconds = 30): CiWait => ({id:crypto.randomUUID(),generation:'generation',turnId:'turn',prUrl:'https://github.com/org/repo/pull/12',repository:'org/repo',prNumber:12,headSha:'a'.repeat(40),registeredAt:new Date().toISOString(),deadline:new Date(Date.now()+seconds*1000).toISOString(),timeoutSeconds:seconds,phase:'registered'});
function supervisor(mode: string, env: Record<string,string> = {}) {
 const s = new CiWatcherSupervisor({github:new GithubCiClient({command:{file:process.execPath,args:[fixture]},env:{...process.env,CI_FIXTURE_MODE:mode,...env}})}); supervisors.push(s); return s;
}
afterEach(async()=>{for(const s of supervisors.splice(0)) s.close(); vi.useRealTimers(); for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
describe('bounded GitHub supervisor',()=>{
 it('resolves canonical identity and rejects unsupported hosts before external work',async()=>{
  const s=supervisor('passed'); expect(await s.resolve('https://github.com/ORG/REPO/pull/12')).toEqual({prUrl:'https://github.com/org/repo/pull/12',repository:'org/repo',prNumber:12,headSha:'a'.repeat(40)});
  await expect(s.resolve('https://untrusted.example/org/repo/pull/12')).rejects.toMatchObject({code:'unsupported_host'});
 });
 it.each(['passed','failed','cancelled','skipped'] as const)('attributes structured %s checks despite command exit codes',async(outcome)=>{
  expect(await supervisor(outcome).watch(wait(),new AbortController().signal)).toMatchObject({outcome,headSha:'a'.repeat(40),totalChecks:1});
 });
 it('detects changed head and preserves the captured head',async()=>{
  expect(await supervisor('head_changed').watch(wait(),new AbortController().signal)).toMatchObject({outcome:'head_changed',headSha:'a'.repeat(40),observedHeadSha:'b'.repeat(40)});
 });
 it.each(['auth','malformed','overflow'])('fails closed for %s without exposing diagnostics',async mode=>{
  const result=await supervisor(mode).watch(wait(),new AbortController().signal); expect(result.outcome).toBe('error'); expect(result.diagnostic).not.toContain('secret-token');
 });
 it('never converts pending checks to success at the deadline',async()=>{
  const result=await supervisor('pending').watch(wait(1),new AbortController().signal); expect(result).toMatchObject({outcome:'deadline',totalChecks:1});
 });
 it('computes failure before truncating the snapshot and enforces the serialized bound',async()=>{
  const result=await supervisor('many').watch(wait(),new AbortController().signal); expect(result).toMatchObject({outcome:'failed',totalChecks:151,truncated:true}); expect(result.checks.length).toBeLessThanOrEqual(100); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
 });
 it('uses fixed watch arguments, aborts owned processes and waits for teardown',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ci-wait-')); dirs.push(dir); const log=join(dir,'log'); const s=supervisor('stubborn',{CI_FIXTURE_LOG:log}); const controller=new AbortController(); const pending=s.watch(wait(),controller.signal);
  await vi.waitFor(async()=>{ expect(await readFile(log,'utf8')).toContain('--watch'); });
  controller.abort(); expect((await pending).outcome).toBe('cancelled');
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {args:string[];pid:number});
  expect(calls.find(c=>c.args.includes('--watch'))?.args).toEqual(['pr','checks','12','--repo','github.com/org/repo','--watch','--interval','10']);
  for(const call of calls) expect(()=>process.kill(call.pid,0)).toThrow();
 },10000);
});

it('turns corrupt persisted identity into a visible error instead of rejecting the watcher promise',async()=>{
 const broken={...wait(),headSha:'not-a-sha'};
 expect((await supervisor('passed').watch(broken,new AbortController().signal)).outcome).toBe('error');
});

it.each(['passed','failed','head_changed'] as const)('attributes a final %s snapshot after real gh watch completes',async outcome=>{
 const dir=await mkdtemp(join(tmpdir(),'ci-watch-final-'));dirs.push(dir);const s=supervisor(`watch_${outcome}`,{CI_FIXTURE_COUNTER:join(dir,'watched')});
 expect(await s.watch(wait(),new AbortController().signal)).toMatchObject({outcome,headSha:'a'.repeat(40),...(outcome==='head_changed'?{observedHeadSha:'b'.repeat(40)}:{totalChecks:1})});
});

it('rejects metadata for a different PR number', async () => {
 await expect(supervisor('passed').resolve('https://github.com/org/repo/pull/13')).rejects.toMatchObject({code:'malformed_data'});
});
