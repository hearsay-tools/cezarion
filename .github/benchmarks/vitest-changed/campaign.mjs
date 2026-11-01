import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function campaign() {
  const { cases } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
  if (cases.length !== 5 || new Set(cases.map(c => c.id)).size !== cases.length) {
    throw new Error('Expected five distinct frozen cases');
  }
  for (const entry of cases) {
    if (!/^[a-z-]+$/.test(entry.id) || !/^[a-f0-9]{40}$/.test(entry.head) || !/^[a-f0-9]{40}$/.test(entry.base)) {
      throw new Error('Campaign requires safe IDs and immutable commit SHAs');
    }
  }
  return cases;
}

export function matrix() {
  return { include: campaign().flatMap((entry, index) => [1, 2, 3, 4].map(shard => ({
    ...entry, shard, first: (index + shard) % 2 ? 'full' : 'selective',
  }))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(matrix()));
}
