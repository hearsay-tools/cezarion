const assert = require('node:assert/strict');
const fixture = require('./release-failure.json');
function harness() {
  const state = {run:structuredClone(fixture.run),jobs:structuredClone(fixture.jobs),annotations:{},issues:[],comments:[],log:fixture.log,failComment:false,failCreate:false,failRead:false,failSearch:false,coreRemaining:5000};
  const calls=[], messages=[];
  // Writes happen after the run was created; each one advances the clock and
  // the issue's updated_at, as GitHub does for a new issue or comment.
  let clock=Date.parse(fixture.run.created_at)+60*60*1000;
  const tick=()=>new Date(clock+=1000).toISOString();
  const touch=number=>{const issue=state.issues.find(entry=>entry.number===number);if(issue)issue.updated_at=tick();};
  const listed=args=>state.issues.filter(issue=>(args.state==='all' || issue.state===args.state)
    && (args.since===undefined || !(Date.parse(issue.updated_at)<Date.parse(args.since))));
  const raw=async(route,args={})=>{
    calls.push([route,args]);
    if(route==='GET /rate_limit') return {data:{resources:{core:{limit:5000,remaining:state.coreRemaining,reset:1794523443}}}};
    if(route==='GET /search/issues') {
      if(state.failSearch) throw new Error('search secret');
      const term=args.q.split(' ').at(-1);
      return {data:{items:structuredClone(state.issues.filter(issue=>issue.state==='closed' && (issue.body||'').includes(term)).reverse())}};
    }
    assert.equal(args.owner,'hearsay-tools');assert.equal(args.repo,'cezarion');
    if (route.endsWith('/attempts/{attempt_number}')) {assert.equal(args.attempt_number,state.run.run_attempt);return {data:structuredClone(state.run)};}
    if(route.endsWith('/attempts/{attempt_number}/jobs')) {assert.equal(args.attempt_number,state.run.run_attempt);return {data:{jobs:structuredClone(state.jobs)}};}
    if(route==='GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations') return {data:structuredClone(state.annotations[args.check_run_id] ?? [])};
    if(route.endsWith('/logs')) { if(state.log===null) throw Object.assign(new Error('expired secret'),{status:410});return {data:state.log};}
    if(route==='GET /repos/{owner}/{repo}/issues') {if(state.failRead) throw new Error('read secret');return {data:structuredClone(listed(args))};}
    if(route==='GET /repos/{owner}/{repo}/issues/{issue_number}/comments')return {data:structuredClone(state.comments.filter(c=>c.issue_number===args.issue_number))};
    if(route==='POST /repos/{owner}/{repo}/issues') {
      if(state.failCreate) throw new Error('write secret');
      const at=tick(), issue={number:state.issues.length+1,state:'open',created_at:at,updated_at:at,...args};state.issues.push(issue);return {data:issue};
    }
    if(route==='POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
      if(state.failComment) {state.failComment=false;throw new Error('comment secret');}
      state.comments.push(args);touch(args.issue_number);return {data:{id:state.comments.length}};
    }
    if(route==='POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
      if(state.failLabel) {state.failLabel=false;throw new Error('label secret');}
      touch(args.issue_number);return {data:args.labels};
    }
    throw new Error(route);
  };
  // Octokit runs every request, pages included, through its request hook.
  let send=async(route,args)=>{
    const response=await raw(route,args);
    return route==='GET /rate_limit' ? response : {headers:{'x-ratelimit-resource':'core','x-ratelimit-remaining':String(--state.coreRemaining)},...response};
  };
  const github={request:(route,args)=>send(route,args),paginate:async(route,args)=>{
    assert.equal(args.per_page,100);
    const {data}=await github.request(route,args);return data.jobs || data;
  },hook:{wrap(name,wrapper){
    assert.equal(name,'request');
    const inner=send;
    send=(route,args={})=>{const [method,url]=route.split(' ');return wrapper(()=>inner(route,args),{method,url,...args});};
  }}};
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
