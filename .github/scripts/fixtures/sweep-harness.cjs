const clone = value => structuredClone(value);
const stamp='2026-09-09T12:00:00Z';
function run(id=1, overrides={}) {
 return {id,run_attempt:1,name:'CI',path:'.github/workflows/ci.yml',status:'completed',conclusion:'failure',head_sha:String(id).padStart(40,'a'),head_branch:`fix/${id}`,head_repository:{full_name:'hearsay-tools/cezarion'},repository:{full_name:'hearsay-tools/cezarion'},created_at:stamp,updated_at:stamp,run_started_at:stamp,pull_requests:[{number:id}],...overrides};
}
function job(id=10, overrides={}) {
 const result={id,run_id:Math.floor(id/10),run_attempt:1,name:'Vitest shard 1/2',conclusion:'failure',started_at:stamp,completed_at:stamp,steps:[{number:3,name:'Run tests',conclusion:'failure',started_at:stamp,completed_at:stamp}],...overrides};
 result.steps=result.steps.map(step=>({started_at:stamp,completed_at:stamp,...step}));
 return result;
}
function harness() {
 const state={runs:[run()],attempts:new Map(),jobs:new Map(),logs:new Map(),issues:[],comments:[],labels:['area-ci','area-cezar','area-web','area-contract','area-api-client']};
 state.attempts.set('1:1',run());state.jobs.set('1:1',[job()]);
 state.logs.set(10,'FAIL packages/cezar/src/a.test.ts > handles input\nAssertionError: expected delivered receipt');
 const calls=[];
 const github={request:async(route,args)=>{
  calls.push([route,clone(args)]);
  const page=rows=>({data:clone(rows.slice(((args.page||1)-1)*100,(args.page||1)*100))});
  if(route==='GET /repos/{owner}/{repo}/actions/runs') {
   const [start,end]=args.created.split('..').map(Date.parse);
   const rows=state.runs.filter(r=>Date.parse(r.created_at)>=start && Date.parse(r.created_at)<=end);
   return {data:{total_count:rows.length,workflow_runs:page(rows).data}};
  }
  if(route.endsWith('/attempts/{attempt_number}')) {
   const data=state.attempts.get(`${args.run_id}:${args.attempt_number}`);
   if(!data)throw Object.assign(new Error('missing attempt'),{status:404});return {data:clone(data)};
  }
  if(route.endsWith('/attempts/{attempt_number}/jobs'))return {data:{jobs:page(state.jobs.get(`${args.run_id}:${args.attempt_number}`)||[]).data}};
  if(route.endsWith('/logs')) {
   const data=state.logs.get(args.job_id);if(data==null)throw Object.assign(new Error('expired private signed URL'),{status:410});return {data};
  }
  if(route==='GET /repos/{owner}/{repo}/issues')return page(state.issues);
  if(route==='GET /repos/{owner}/{repo}/labels')return page(state.labels.map(name=>({name})));
  if(route==='GET /repos/{owner}/{repo}/issues/{issue_number}/comments')return page(state.comments.filter(c=>c.issue_number===args.issue_number));
  if(route==='POST /repos/{owner}/{repo}/issues') {
   const issue={number:Math.max(0,...state.issues.map(i=>i.number))+1,state:'open',...clone(args)};state.issues.push(issue);return {data:clone(issue)};
  }
  if(route==='PATCH /repos/{owner}/{repo}/issues/{issue_number}') {
   const issue=state.issues.find(i=>i.number===args.issue_number);Object.assign(issue,clone(args));return {data:clone(issue)};
  }
  if(route==='POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
   const comment={id:Math.max(0,...state.comments.map(c=>c.id))+1,...clone(args)};state.comments.push(comment);return {data:clone(comment)};
  }
  if(route==='PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
   const comment=state.comments.find(c=>c.id===args.comment_id);Object.assign(comment,clone(args));return {data:clone(comment)};
  }
  throw new Error(`Unhandled fixture route ${route}`);
 }};
 return {state,calls,github};
}
module.exports={harness,run,job,stamp};
