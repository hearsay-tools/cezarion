// hearsay-tools/cezarion#784: harness parity reads which per-session variables reached each runner's
// native process, the one the agent's Bash and agent-browser inherit. A test preloads it into every
// mock with NODE_OPTIONS=--import=<this file's URL> and sets CEZ_MOCK_ENV_RECORD (the file to write)
// and CEZ_MOCK_ENV_RECORD_NAMES (comma-separated names).
import { writeFileSync } from 'node:fs';

const path = process.env.CEZ_MOCK_ENV_RECORD;
if (path) {
  const names = (process.env.CEZ_MOCK_ENV_RECORD_NAMES ?? '').split(',').filter(Boolean);
  writeFileSync(path, JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name] ?? null]))));
}
