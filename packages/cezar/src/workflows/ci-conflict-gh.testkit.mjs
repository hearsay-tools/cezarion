// A separate native gh wire: identity and mergeability are external JSON, never normalized events.
import { existsSync, appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const [gate, log, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify(args) + '\n');
if (args[1] === 'view') {
  console.log(JSON.stringify({ url: 'https://github.com/acme/repo/pull/12', number: 12,
    headRefOid: 'a'.repeat(40), mergeable: existsSync(gate + '.clean') ? 'MERGEABLE' : 'CONFLICTING', mergeStateStatus: existsSync(gate + '.clean') ? 'CLEAN' : 'DIRTY' }));
} else if (args[0] === 'api') {
  console.log(JSON.stringify({ total_count: 0, workflow_runs: [] }));
} else {
  while (!existsSync(gate)) await setTimeout(5);
  console.log(JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass', link: '' }]));
}
