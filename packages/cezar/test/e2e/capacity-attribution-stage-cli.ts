/** CI preparer: read and validate every input before writing any staged output. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attributionInputs, instrumentAttributionSources, instrumentCapacityFixture } from './capacity-attribution-sites.ts';
import { validateAttributionSupervisor } from './capacity-attribution-auth.ts';

const root = resolve(process.argv[2] ?? '');
const output = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) throw new Error('attribution requires explicit root and staging file');
validateAttributionSupervisor(root);
const sources = Object.fromEntries(attributionInputs.map(file => [file, readFileSync(resolve(root, 'packages/cezar/src/delegation', file), 'utf8')]));
const fixture = readFileSync(resolve(root, 'packages/cezar/src/delegation/authoritative-capacity-ci.test.ts'), 'utf8');
const staged = instrumentAttributionSources(sources);
const patchedFixture = instrumentCapacityFixture(fixture, 'cf9e4a7a33ddb2b89ccceeb94775eaca48a87d2433f4ea07b15c3b956cbf62f0');
writeFileSync(output, JSON.stringify({ ...staged, 'authoritative-capacity-ci.test.ts': patchedFixture }), { flag: 'wx', mode: 0o600 });
