import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_PROCESS_WRAPPER, GithubCiClient, runCiCommand } from './github.ts';
const fixture=fileURLToPath(new URL('./fixtures/gh.mjs',import.meta.url));
const dirs:string[]=[];
const aborts:AbortController[]=[];
afterEach(async()=>{for(const c of aborts.splice(0))c.abort();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function workspace(){const dir=await mkdtemp(join(tmpdir(),'ci-process-'));dirs.push(dir);return dir;}
async function calls(path:string):Promise<Array<{args:string[];pid:number}>>{return (await readFile(path,'utf8')).trim().split('\n').map(s=>JSON.parse(s));}
it('kills the owned watcher when the controller dies without running cleanup',async()=>{
 const dir=await workspace();const log=join(dir,'log');
 // A real intermediate controller dies by SIGKILL, closing its pipe to the wrapper.
 const source=`const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(CI_PROCESS_WRAPPER)},${JSON.stringify(JSON.stringify({file:process.execPath,args:[fixture,'pr','checks','12','--watch']}))}],{stdio:['pipe','ignore','ignore']});setInterval(()=>{},1000);`;
 const parent=spawn(process.execPath,['-e',source],{env:{...process.env,CI_FIXTURE_MODE:'stubborn',CI_FIXTURE_LOG:log},stdio:'ignore'});
 try {
  await vi.waitFor(async()=>expect((await calls(log)).length).toBe(1));const pid=(await calls(log))[0]!.pid;parent.kill('SIGKILL');
  await vi.waitFor(async()=>{
   try{process.kill(pid,0);}catch{return;}
   // Linux init can retain an exited orphan as a zombie; it is no longer executing.
   if(process.platform==='linux'){expect((await readFile(`/proc/${pid}/stat`,'utf8')).split(' ')[2]).toBe('Z');return;}
   throw new Error('Owned watcher is still alive');
  },{timeout:5000,interval:50});
 }finally{parent.kill('SIGKILL');}
},10000);
it('bounds structured subprocess output and discards watch redraws',async()=>{
 const c=new AbortController();aborts.push(c);
 await expect(runCiCommand({file:process.execPath,args:[fixture]},c.signal,false,{...process.env,CI_FIXTURE_MODE:'overflow'})).rejects.toMatchObject({code:'output_limit'});
 expect(await runCiCommand({file:process.execPath,args:[fixture]},c.signal,true,{...process.env,CI_FIXTURE_MODE:'overflow'})).toMatchObject({code:0,stdout:''});
});
it('limits short queries to four and removes an aborted queued query',async()=>{
 const dir=await workspace();const log=join(dir,'log');
 const client=new GithubCiClient({command:{file:process.execPath,args:['-e',`require('node:fs').appendFileSync(process.env.CI_FIXTURE_LOG,process.pid+'\\n');setInterval(()=>{},1000);`]},env:{...process.env,CI_FIXTURE_LOG:log}});
 const cs=Array.from({length:5},()=>new AbortController());aborts.push(...cs);
 const queries=cs.map(c=>client.resolve('https://github.com/org/repo/pull/12',c.signal).catch(e=>e));
 await vi.waitFor(async()=>expect((await readFile(log,'utf8')).trim().split('\n')).toHaveLength(4));
 cs[4]!.abort();await queries[4];cs[0]!.abort();await queries[0];
 expect((await readFile(log,'utf8')).trim().split('\n')).toHaveLength(4);
 for(const c of cs)c.abort();await Promise.all(queries);
});
it('uses the same structured commands in dry run without gh or credentials',async()=>{
 const client=new GithubCiClient({env:{CEZ_DRY_RUN:'1'}});const signal=new AbortController().signal;
 const pr=await client.resolve('https://github.com/org/repo/pull/12',signal);expect(pr).toMatchObject({repository:'org/repo',prNumber:12});
 expect(await client.checks(pr,signal)).toEqual([{name:'Dry-run checks',state:'SUCCESS',bucket:'pass',link:''}]);
 await expect(client.watch(pr,signal)).resolves.toBeUndefined();
});

it('bounds a hanging registration metadata query to ten seconds and releases its permit',async()=>{
 const client=new GithubCiClient({command:{file:process.execPath,args:['-e','setInterval(()=>{},1000);']}});
 await expect(client.resolve('https://github.com/org/repo/pull/12',new AbortController().signal)).rejects.toMatchObject({code:'query_timeout'});
},15000);

it('recognizes gh 2.100.0 empty-check output without treating it as success',async()=>{
 const client=new GithubCiClient({command:{file:process.execPath,args:[fixture]},env:{...process.env,CI_FIXTURE_MODE:'no_checks'}});
 const signal=new AbortController().signal;const pr=await client.resolve('https://github.com/org/repo/pull/12',signal);expect(await client.checks(pr,signal)).toEqual([]);
});

it('reports a missing gh binary as actionable gh_missing',async()=>{
 const client=new GithubCiClient({command:{file:'/definitely-missing-cezar-gh',args:[]}});
 await expect(client.resolve('https://github.com/org/repo/pull/12',new AbortController().signal)).rejects.toMatchObject({code:'gh_missing'});
});
it('cleans descendant processes after the command leader exits normally',async()=>{
 const command={file:process.execPath,args:['-e',"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(c.pid);process.exit(0)"]};
 const result=await runCiCommand(command,AbortSignal.timeout(1000));expect(result.code).toBe(0);
});
