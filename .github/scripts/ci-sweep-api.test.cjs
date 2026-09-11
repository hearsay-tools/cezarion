const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const apiModule = fs.existsSync(__dirname+'/ci-sweep-api.cjs') ? require('./ci-sweep-api.cjs') : {};
const create = options => { assert.equal(typeof apiModule.createSweepApi,'function','bounded sweep API is implemented'); return apiModule.createSweepApi(options); };

test('request cap stops further requests and marks coverage incomplete without exposing errors', async()=>{
 let calls=0;
 const api=create({github:{request:async()=>{calls++;return {data:[]};}},limits:{requests:1}});
 await api.request('GET /repos/{owner}/{repo}/issues',{});
 await assert.rejects(api.request('GET /repos/{owner}/{repo}/issues',{}), /request-limit/);
 assert.equal(calls,1);assert.equal(api.manifest.complete,false);
 assert.equal(api.manifest.problems[0].code,'request-limit');
});
test('paginated reads exhaust every page and reject partial issue indexes',async()=>{
 const pages=[];
 const api=create({github:{request:async(route,args)=>{pages.push(args.page); if(args.page===1)return {data:Array.from({length:100},(_,i)=>({number:i+1}))};return {data:[{number:101}]};}}});
 assert.equal((await api.paginate('GET /repos/{owner}/{repo}/issues',{})).length,101);
 assert.deepEqual(pages,[1,2]);
 const failing=create({github:{request:async(route,args)=>{if(args.page===1)return {data:Array(100).fill({number:1})};throw Object.assign(new Error('Authorization: secret-token'),{status:403});}}});
 await assert.rejects(failing.paginate('GET /repos/{owner}/{repo}/issues',{}), /rate-limit/);
 assert.equal(failing.manifest.complete,false);assert.doesNotMatch(JSON.stringify(failing.manifest),/secret-token|Authorization/);
});
test('deadline prevents API traffic and metadata errors expose fixed codes only',async()=>{
 let clock=0,calls=0;
 const api=create({github:{request:async()=>{calls++;throw new Error('private response');}},now:()=>clock,limits:{durationMs:10}});
 await assert.rejects(api.request('GET /any',{}),/api-read/);
 clock=11;await assert.rejects(api.request('GET /any',{}),/time-limit/);
 assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(api.manifest),/private response/);
});
test('logs consume shared byte and count budgets and missing logs remain visible',async()=>{
 const api=create({github:{request:async()=>({data:'123456'})},limits:{logBytes:10,logs:5}});
 assert.equal(await api.downloadLog({owner:'o',repo:'r',job_id:1}),'123456');
 assert.equal(await api.downloadLog({owner:'o',repo:'r',job_id:2}),null);
 assert.equal(api.manifest.complete,false);assert.ok(api.manifest.problems.some(p=>p.code==='log-byte-limit'));
 const missing=create({github:{request:async()=>{throw Object.assign(new Error('signed private url'),{status:410});}}});
 assert.equal(await missing.downloadLog({job_id:3}),null);
 assert.ok(missing.manifest.problems.some(p=>p.code==='logs-unavailable' && p.jobId===3));
 assert.doesNotMatch(JSON.stringify(missing.manifest),/private/);
});
test('expired job logs are recorded evidence gaps that do not fail the sweep',async()=>{
 const missing=create({github:{request:async()=>{throw Object.assign(new Error('signed private url'),{status:410});}}});
 assert.equal(await missing.downloadLog({job_id:3}),null);
 assert.equal(missing.manifest.complete,true);
 assert.ok(missing.manifest.problems.some(p=>p.code==='logs-unavailable' && p.jobId===3));
});
test('signed log fetch streams into cumulative budget without forwarding authorization',async()=>{
 let fetched;
 const api=create({github:{request:async()=>({headers:{location:'https://example.com/log?signature=private'}})},limits:{logBytes:5},fetchImpl:async(url,options)=>{
  fetched=options;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('123456'));c.close();}}));
 }});
 assert.equal(await api.downloadLog({job_id:4}),null);
 assert.equal(fetched.headers,undefined);assert.equal(fetched.redirect,'error');
 assert.ok(api.manifest.problems.some(p=>p.code==='log-byte-limit'));
});
test('declared job totals prevent a short partial page becoming complete pass evidence',async()=>{
 const api=create({github:{request:async(route,args)=>({data:{total_count:2,jobs:args.page===1?[{id:1,conclusion:'success'}]:[]}})}});
 await assert.rejects(api.paginate('GET /jobs',{}),/pagination-gap/);
 assert.equal(api.manifest.complete,false);
});
test('deadline crossed by the final API response still marks coverage incomplete',async()=>{
 let clock=0;
 const api=create({github:{request:async()=>{clock=20;return {data:[]};}},now:()=>clock,limits:{durationMs:10}});
 await assert.rejects(api.request('GET /runs',{}),/time-limit/);assert.equal(api.manifest.complete,false);
});
test('malformed rows in paginated API data fail closed with an explicit coverage problem',async()=>{
 const api=create({github:{request:async()=>({data:{total_count:1,jobs:[null]}})}});
 await assert.rejects(api.paginate('GET /jobs',{}));assert.equal(api.manifest.complete,false);
});
test('signed log download aborts at the remaining sweep deadline',async()=>{
 let clock=0;
 const api=create({now:()=>clock,limits:{durationMs:100},github:{request:async()=>{
  clock=90;return {headers:{location:'https://example.com/log'}};
 }},fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>{clock=100;reject(signal.reason);},{once:true});
 })});
 let timer;
 const result=await Promise.race([api.downloadLog({job_id:1}),new Promise(resolve=>{timer=setTimeout(()=>resolve('deadline missed'),200);})]);
 clearTimeout(timer);
 assert.equal(result,null);
 assert.ok(api.manifest.problems.some(p=>p.code==='time-limit'));
 assert.equal(api.stopped,true);
});
