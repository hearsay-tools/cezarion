const assert = require('node:assert/strict');
const fixture = require('./release-failure.json');
function harness() {
  const state = {run:structuredClone(fixture.run),jobs:structuredClone(fixture.jobs),annotations:{},issues:[],comments:[],log:fixture.log,failComment:false,failCreate:false,failRead:false};
  const calls=[], messages=[];
  const request=async(route,args)=>{
    calls.push([route,args]); assert.equal(args.owner,'hearsay-tools');assert.equal(args.repo,'cezarion');
    if (route.endsWith('/attempts/{attempt_number}')) {assert.equal(args.attempt_number,state.run.run_attempt);return {data:structuredClone(state.run)};}
    if(route.endsWith('/attempts/{attempt_number}/jobs')) {assert.equal(args.attempt_number,state.run.run_attempt);return {data:{jobs:structuredClone(state.jobs)}};}
    if(route==='GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations') return {data:structuredClone(state.annotations[args.check_run_id] ?? [])};
    if(route.endsWith('/logs')) { if(state.log===null) throw Object.assign(new Error('expired secret'),{status:410});return {data:state.log};}
    if(route==='GET /repos/{owner}/{repo}/issues') {if(state.failRead) throw new Error('read secret');return {data:structuredClone(state.issues)};}
    if(route==='GET /repos/{owner}/{repo}/issues/{issue_number}/comments')return {data:structuredClone(state.comments.filter(c=>c.issue_number===args.issue_number))};
    if(route==='POST /repos/{owner}/{repo}/issues') {
      if(state.failCreate) throw new Error('write secret');
      const issue={number:state.issues.length+1,state:'open',...args};state.issues.push(issue);return {data:issue};
    }
    if(route==='POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
      if(state.failComment) {state.failComment=false;throw new Error('comment secret');}
      state.comments.push(args);return {data:{id:state.comments.length}};
    }
    if(route==='POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
      if(state.failLabel) {state.failLabel=false;throw new Error('label secret');}
      return {data:args.labels};
    }
    throw new Error(route);
  };
  const github={request,paginate:async(route,args)=>{
    assert.equal(args.per_page,100);
    const {data}=await request(route,args);return data.jobs || data;
  }};
  return {state,calls,messages,options:{github,owner:'hearsay-tools',repo:'cezarion',event:{action:'completed',workflow_run:structuredClone(state.run)},log:m=>messages.push(m)}};
}
function nightly(h, publish=false) {
 Object.assign(h.state.run,{id:123,name:'Nightly',path:'.github/workflows/nightly.yml',head_branch:'main'});
 h.state.jobs=[{...h.state.jobs[0],id:456,name:'Publish nightly to npm',steps:[{...h.state.jobs[0].steps.find(s=>s.conclusion==='failure'),name:publish?'Publish nightly':'Verify before publishing'}]}];
 h.options.event.workflow_run=structuredClone(h.state.run);
 if(publish)h.state.log='npm error code E403\nnpm error Forbidden: package publishing denied';
}
// A Nightly job stopped by Actions. Its run, job and running step all end
// `cancelled`; only the check-run annotation names the time limit (run 39225553369).
const TIME_LIMIT='The job has exceeded the maximum execution time of 20m0s';
function stopped(h, annotation=TIME_LIMIT) {
 nightly(h);
 h.state.run.conclusion='cancelled';h.options.event.workflow_run.conclusion='cancelled';
 const job=h.state.jobs[0];job.conclusion='cancelled';job.steps[0].conclusion='cancelled';
 h.state.annotations={[job.id]:[{annotation_level:'failure',message:annotation},{annotation_level:'failure',message:'The operation was canceled.'}]};
 h.state.log='✓ src/runs/manager.test.ts > settles a parked run 812ms\n✓ src/runs/manager.test.ts > keeps the claim across recovery 640ms\n##[error]The operation was canceled.';
}
module.exports={harness,nightly,stopped,TIME_LIMIT};
