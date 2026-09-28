// Run: node --import tsx .ai/analysis/662-github-refresh/profile.mjs > /tmp/662-profile.json
// Read-only GitHub calls; isolated workspace/store; does not start background workers.
import cp from 'node:child_process';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'cez-662-'));
process.env.CEZ_HOME = join(temp, 'home');
delete process.env.CEZ_DRY_RUN;
const original = cp.execFile;
let calls = [], epoch = performance.now();
cp.execFile = function(file, args, options, callback) {
  const start = performance.now();
  const cb = typeof options === 'function' ? options : callback;
  const label = file === 'gh' ? (args[0] === 'api' ? (args.find(a => a.startsWith('query='))?.includes('issueOrPullRequest') ? 'ref-graphql' : args.find(a => a.startsWith('query='))?.includes('projectsV2') ? 'projects-graphql' : args.find(a => a.startsWith('query='))?.includes('projectItems') ? 'membership-graphql' : args.find(a => a.startsWith('query='))?.includes('viewer') ? 'viewer-graphql' : 'counts-graphql') : args.slice(0, 2).join(' ')) : file;
  const wrapped = (err, stdout, stderr) => {
    calls.push({ label, startMs: +(start-epoch).toFixed(2), ms: +(performance.now()-start).toFixed(2), bytes: Buffer.byteLength(stdout ?? ''), ok: !err });
    cb(err, stdout, stderr);
  };
  return typeof options === 'function' ? original(file,args,wrapped) : original(file,args,options,wrapped);
};
cp.execFile[promisify.custom] = (file,args,options) => new Promise((resolve,reject) => cp.execFile(file,args,options,(err,stdout,stderr) => { if(err) { err.stdout=stdout; err.stderr=stderr; reject(err); } else resolve({stdout,stderr}); }));
syncBuiltinESMExports();
const github = await import(resolve(root, 'packages/cezar/src/server/forge/github.ts'));
const { createApp } = await import(resolve(root, 'packages/cezar/src/server/server.ts'));
const { RunStore } = await import(resolve(root, 'packages/cezar/src/runs/store.ts'));
const require = createRequire(resolve(root, 'packages/cezar/package.json'));
const { serve } = require('@hono/node-server');
const store = RunStore.open(join(temp,'data'));
const app = createApp({repoRoot: root, store, manager: {}, version: 'profile-662'});
const server = serve({fetch: app.fetch, hostname:'127.0.0.1',port:0});
await new Promise(r=>server.listening ? r() : server.once('listening',r));
const origin = `http://127.0.0.1:${server.address().port}`;
const samples=[];
async function sample(name, paths) {
  calls=[]; epoch=performance.now();
  const results = await Promise.all(paths.map(async path=> {
    const start=performance.now(); const res=await fetch(origin+path); const headers=performance.now();
    const body=await res.json(); if (body.available !== true) throw new Error('Profile request did not return available data: '+body.reason);
    return {status:res.status, ttfbMs:+(headers-start).toFixed(2), totalMs:+(performance.now()-start).toFixed(2), available:body.available, ...(body.projectsGeneration ? {projectsGeneration:body.projectsGeneration, projectsState:body.projectsState} : {}), ...(body.reason ? {reason:body.reason} : {}), prs:Object.keys(body.prs??{}).length, issues:Object.keys(body.issues??{}).length};
  }));
  const ms = +(performance.now()-epoch).toFixed(2);
  // Drain optional work before resetting the span epoch for the next sample. First-list
  // timings above retain the diagnosis boundary (HTTP request through body parse).
  const hydration = [];
  for (const result of results) if (result.projectsGeneration && result.projectsState === 'refreshing') {
    const response = await fetch(origin+'/api/v1/github/projects?generation='+result.projectsGeneration);
    const metadata = await response.json();
    hydration.push({state:metadata.state, completedMs:+(performance.now()-epoch).toFixed(2)});
  }
  samples.push({name,paths,ms,results,calls:[...calls],...(hydration.length ? {hydration} : {})});
}
try {
  const ref='/api/v1/github/ref-status?prs=670&issues=662';
  for(let i=0;i<5;i++) {
    github.__clearRefStatusCacheForTests(); github.__clearRepoHandleCacheForTests();
    await sample('cold-ref', [ref]);
    await sample('warm-ref', [ref]);
    github.__clearRefStatusCacheForTests();
    await sample('warm-handle-cold-ref', [ref]);
  }
  github.__clearRefStatusCacheForTests(); github.__clearRepoHandleCacheForTests();
  await sample('concurrent-overlap', [ref, '/api/v1/github/ref-status?prs=670&issues=661,662']);
  const recentPrs = JSON.parse(cp.execFileSync('gh',['pr','list','--state','all','--limit','20','--json','number'],{encoding:'utf8'})).map(x=>x.number);
  for(let i=0;i<3;i++) {
    github.__clearRefStatusCacheForTests();
    await sample('20-recent-prs-warm-handle', ['/api/v1/github/ref-status?prs='+recentPrs.join(',')+'&issues=662']);
  }
  for(let i=0;i<3;i++) {
    await sample('list-refresh-1000', ['/api/v1/github?refresh=1&limit=1000']);
    await sample('list-warm-1000', ['/api/v1/github?limit=1000']);
  }
  console.log(JSON.stringify({commit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),samples},null,2));
} finally { store.flush(); await new Promise(r=>server.close(r)); rmSync(temp,{recursive:true,force:true}); }
