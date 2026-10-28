/** Verify the archived inputs and staged payload before modifying the disposable copy. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attributionInputs, instrumentAttributionSources, instrumentCapacityFixture } from './capacity-attribution-sites.ts';
import { validateAttributionSupervisor } from './capacity-attribution-auth.ts';

const root = resolve(process.argv[2] ?? '');
const stagedFile = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) throw new Error('attribution requires explicit copy and staging file');
validateAttributionSupervisor(root);
const dir = resolve(root, 'packages/cezar/src/delegation');
const sources = Object.fromEntries(attributionInputs.map(file => [file, readFileSync(resolve(dir, file), 'utf8')]));
const fixture = readFileSync(resolve(dir, 'authoritative-capacity-ci.test.ts'), 'utf8');
const expected = { ...instrumentAttributionSources(sources), 'authoritative-capacity-ci.test.ts': instrumentCapacityFixture(fixture, 'cf9e4a7a33ddb2b89ccceeb94775eaca48a87d2433f4ea07b15c3b956cbf62f0') };
const staged: unknown = JSON.parse(readFileSync(stagedFile, 'utf8'));
if (JSON.stringify(staged) !== JSON.stringify(expected)) throw new Error('attribution staged output changed');
for (const [file, source] of Object.entries(expected)) writeFileSync(resolve(dir, file), source);
