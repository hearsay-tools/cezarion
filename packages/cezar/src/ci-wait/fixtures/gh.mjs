// Wire fixture: gh pr view --json url,number,headRefOid and gh pr checks --json
// gh 2.100.0 (installed 2026-09-22): https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/pr/checks/checks.go
// JSON fields/buckets and empty-check diagnostic pinned to that upstream implementation.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.CI_FIXTURE_MODE || 'passed';
if (process.env.CI_FIXTURE_LOG) appendFileSync(process.env.CI_FIXTURE_LOG, JSON.stringify({args,pid:process.pid})+'\n');
const head = 'a'.repeat(40);
const watched = process.env.CI_FIXTURE_COUNTER && existsSync(process.env.CI_FIXTURE_COUNTER);
const phase = mode.startsWith('watch_') ? (watched ? mode.slice(6) : 'pending') : mode;
if (mode === 'auth') { console.error('HTTP 401: authentication required secret-token'); process.exit(1); }
if (mode === 'overflow') { process.stdout.write('x'.repeat(70*1024)); process.exit(0); }
if (mode === 'malformed') { console.log('{bad'); process.exit(0); }
if (mode === 'transient') {
 const file = process.env.CI_FIXTURE_COUNTER;
 const count = existsSync(file) ? Number(readFileSync(file,'utf8')) : 0;
 writeFileSync(file,String(count+1));
 if (count < 3) { console.error('HTTP 503 service unavailable'); process.exit(1); }
}
if (args[1] === 'view') {
 console.log(JSON.stringify({url:'https://github.com/org/repo/pull/12',number:12,headRefOid: phase === 'head_changed' ? 'b'.repeat(40) : head}));
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
 if (mode === 'many') for(let i=0;i<150;i++) rows.push({name:'x'.repeat(256),state:i===149?'FAILURE':'SUCCESS',bucket:i===149?'fail':'pass',link:''});
 console.log(JSON.stringify(rows));
 process.exit(mode === 'failed' ? 1 : mode === 'pending' ? 8 : 0);
}
