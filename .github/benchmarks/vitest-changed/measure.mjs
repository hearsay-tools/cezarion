import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { campaign } from './campaign.mjs';
import { execute } from './execute.mjs';
import { plan, shardFiles } from './plan.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' },
  case: { type: 'string' }, shard: { type: 'string' }, first: { type: 'string' } } });
const entry = campaign().find(item => item.id === values.case);
const shard = Number(values.shard);
if (!entry || !values.root || !values.output || ![1, 2, 3, 4].includes(shard)
  || !['full', 'selective'].includes(values.first)) throw new Error('Invalid pilot arguments');
const root = resolve(values.root);
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== entry.head || git('rev-parse', 'HEAD^') !== entry.base) {
  throw new Error('Application source or base differs from the frozen campaign');
}
const metadata = { entry, shard, first: values.first, node: process.version,
  platform: platform(), release: release(), cpu: cpus()[0]?.model, cpus: cpus().length,
  totalMemory: totalmem(), image: process.env.ImageVersion,
  lockSha256: createHash('sha256').update(readFileSync(join(root, 'pnpm-lock.yaml'))).digest('hex'),
  scope: 'Advisory experiment; not a required CI verdict; selective coverage is partial' };
writeFileSync(join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
const selection = await plan(root, entry.base);
writeFileSync(join(output, 'selection.json'), JSON.stringify(selection, null, 2));
const order = values.first === 'full' ? ['full', 'selective'] : ['selective', 'full'];
const results = [];
for (const mode of order) {
  const files = mode === 'full' ? selection.inventory.map(spec => spec.file) : selection.files;
  const expected = await shardFiles(root, selection.inventory, files, shard);
  const result = execute({ root, output, mode, shard, files, expected });
  results.push(result);
  writeFileSync(join(output, 'results.json'), JSON.stringify({ metadata, selectionMs: selection.selectionMs,
    selectionMode: selection.mode, selectionReason: selection.reason, results }, null, 2));
  console.log(JSON.stringify({ case: entry.id, shard, mode, exit: result.exitCode,
    wallSeconds: result.wallMs / 1000, files: result.actual?.length, validInventory: result.validInventory }));
}
if (results.some(result => result.exitCode !== 0 || !result.validInventory || !result.success)) process.exitCode = 1;
