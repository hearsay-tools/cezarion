// A separate native gh wire for PR merge waits (hearsay-tools/cezarion#1425): the PR's state is
// external JSON. `<gate>.passed` turns its checks green; only `<gate>.merged` merges it.
import { existsSync, appendFileSync } from 'node:fs';
const [gate, log, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify(args) + '\n');
const merged = existsSync(gate + '.merged');
if (args[1] === 'view') {
  console.log(JSON.stringify({ url: 'https://github.com/acme/repo/pull/12', number: 12, headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: merged ? 'MERGED' : 'OPEN',
    mergedAt: merged ? '2026-10-23T09:00:00Z' : null, mergeCommit: merged ? { oid: 'b'.repeat(40) } : null }));
} else if (args[0] === 'api') {
  console.log(JSON.stringify({ total_count: 0, workflow_runs: [] }));
} else {
  const state = existsSync(gate + '.passed') ? 'SUCCESS' : 'PENDING';
  console.log(JSON.stringify([{ name: 'build', state, bucket: state === 'SUCCESS' ? 'pass' : 'pending', link: '' }]));
}
