// Wire fixture: gh pr view --json url,number,headRefOid,mergeable,mergeStateStatus and gh pr checks --json
// gh 2.100.0 (installed 2026-09-22): https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/pr/checks/checks.go
// JSON fields/buckets and empty-check diagnostic pinned to that upstream implementation.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.CI_FIXTURE_MODE || 'passed';
if (process.env.CI_FIXTURE_LOG) appendFileSync(process.env.CI_FIXTURE_LOG, JSON.stringify({args,pid:process.pid})+'\n');
const head = 'a'.repeat(40);
const watched = process.env.CI_FIXTURE_COUNTER && existsSync(process.env.CI_FIXTURE_COUNTER);
const conflicting = process.env.CI_FIXTURE_CONFLICT_FILE && existsSync(process.env.CI_FIXTURE_CONFLICT_FILE);
const phase = mode.startsWith('watch_') ? (watched ? mode.slice(6) : 'pending') : mode;
const rerun = process.env.CI_FIXTURE_RERUN_STATE && readFileSync(process.env.CI_FIXTURE_RERUN_STATE,'utf8');
if (mode === 'auth') { console.error('HTTP 401: authentication required secret-token'); process.exit(1); }
if (mode === 'overflow') { process.stdout.write('x'.repeat(70*1024)); process.exit(0); }
if (mode === 'malformed') { console.log('{bad'); process.exit(0); }
if (mode === 'transient') {
 const file = process.env.CI_FIXTURE_COUNTER;
 const count = existsSync(file) ? Number(readFileSync(file,'utf8')) : 0;
 writeFileSync(file,String(count+1));
 if (count < 3) { console.error('HTTP 503 service unavailable'); process.exit(1); }
}
if (args[0] === 'api') {
 if (process.env.CI_FIXTURE_API_ERROR) { console.error(process.env.CI_FIXTURE_API_ERROR); process.exit(1); }
 const pages = rerun ? [{total_count:1,workflow_runs:[{id:1,head_sha:head,status:rerun==='complete'?'completed':rerun==='hidden'?'queued':'in_progress'}]}] : JSON.parse(process.env.CI_FIXTURE_RUN_PAGES || '[{"total_count":0,"workflow_runs":[]}]');
 for (const page of pages) console.log(JSON.stringify({...page,workflow_runs:page.workflow_runs?.map(run=>[run.id,run.status,typeof run.head_sha==='string' && /^[0-9a-f]{40}$/i.test(run.head_sha) ? run.head_sha.toLowerCase()===head : null])}));
} else if (args[1] === 'view') {
 console.log(JSON.stringify({url:'https://github.com/org/repo/pull/12',number:12,headRefOid: phase === 'head_changed' ? 'b'.repeat(40) : head, mergeable: conflicting || phase === 'conflicting' ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: conflicting || phase === 'conflicting' ? 'DIRTY' : 'CLEAN'}));
} else if (args.includes('--watch')) {
 if(mode.startsWith('watch_')) { writeFileSync(process.env.CI_FIXTURE_COUNTER,'done'); process.exit(mode === 'watch_failed' ? 1 : 0); }
 if (mode === 'pending' || mode === 'stubborn') {
   if (mode === 'stubborn') process.on('SIGTERM',()=>{});
   setInterval(()=>process.stdout.write('redraw\n'), 20);
 } else process.exit(mode === 'failed' ? 1 : 0);
} else {
 if(mode === 'no_checks') { console.error("no checks reported on the 'feature' branch"); process.exit(1); }
 const buckets = { passed:'pass',failed:'fail',cancelled:'cancel',skipped:'skipping',pending:'pending',stubborn:'pending',transient:'pass' };
 const rows = mode === 'no_checks' ? [] : [{name:'build',state:({pending:'PENDING',stubborn:'PENDING',failed:'FAILURE',cancelled:'CANCELLED',skipped:'SKIPPED'})[phase]||'SUCCESS',bucket:buckets[phase]||'pass',link:'https://github.com/org/repo/actions/runs/1'}];
 if (rerun && rerun !== 'hidden') rows.push({name:'review rerun',state:rerun==='complete'?'SUCCESS':'PENDING',bucket:rerun==='complete'?'pass':'pending',link:'https://github.com/org/repo/actions/runs/1/job/2'});
 if (phase.startsWith('mixed_')) {
  rows.push({name:'optional publish',state:'SKIPPED',bucket:'skipping',link:''});
  const result = phase.slice(6);
  rows[0].bucket = buckets[result];
  rows[0].state = {passed:'SUCCESS',failed:'FAILURE',cancelled:'CANCELLED',skipped:'SKIPPED'}[result];
 }
 if (mode === 'many') for(let i=0;i<150;i++) rows.push({name:'x'.repeat(256),state:i===149?'FAILURE':'SUCCESS',bucket:i===149?'fail':'pass',link:''});
 console.log(JSON.stringify(rows));
 process.exit(mode === 'failed' ? 1 : mode === 'pending' ? 8 : 0);
}
