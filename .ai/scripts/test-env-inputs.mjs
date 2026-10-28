// The tracked settings the shared browser test environment boots from (hearsay-tools/cezarion#1977).
// `.ai/qa/test-env.json` is runtime state: a pid, a port, timestamps and a status that every boot
// and stop rewrites, so Squeal ignores it for browser specs (`runtimeFiles` in squeal.config.json).
// What can change a test result lives in test-env.inputs.json instead, a declared input that
// Squeal reads before it decides to reuse a result. test-env-up.sh boots from it and records its
// digest in the descriptor; the browser seam refuses an environment booted from other settings.
//
// The rest of the environment is pinned in tracked files already: the server's dry-run mode and
// homes in test-env-up.sh, the Chrome flags in resolve-browser-launch.mjs (from host signals).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEST_ENV_INPUTS = '.ai/scripts/test-env.inputs.json';

// The --server-env rule of test-env-up.sh: CEZ_DRY_RUN and CEZ_HOME are pinned by the script.
const SERVER_ENV = /^CEZ_[A-Z0-9_]+=\S*$/;
const PINNED_ENV = new Set(['CEZ_DRY_RUN', 'CEZ_HOME']);

function validate(inputs) {
  if (inputs?.version !== 1) throw new Error('version must be 1');
  const env = inputs.server?.env;
  if (!Array.isArray(env)) throw new Error('server.env must be an array');
  for (const assignment of env) {
    if (typeof assignment !== 'string' || !SERVER_ENV.test(assignment) || PINNED_ENV.has(assignment.split('=')[0])) {
      throw new Error(`server.env: ${JSON.stringify(assignment)} is not CEZ_NAME=value (CEZ_DRY_RUN and CEZ_HOME are pinned)`);
    }
  }
  const version = inputs.browser?.agentBrowserVersion;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('browser.agentBrowserVersion must be a release version such as 0.39.4');
  }
  return inputs;
}

/** The parsed inputs and the sha256 of their bytes, the identity a descriptor records. */
export function readTestEnvInputs(root) {
  const file = resolve(root, TEST_ENV_INPUTS);
  const bytes = readFileSync(file);
  let inputs;
  try { inputs = validate(JSON.parse(bytes.toString('utf8'))); }
  catch (error) { throw new Error(`${TEST_ENV_INPUTS}: ${error.message}`); }
  return { inputs, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Why the environment a descriptor names was not booted from the current inputs, or undefined. */
export function testEnvInputsMismatch(root, descriptor) {
  const booted = descriptor?.inputs?.sha256;
  if (booted === readTestEnvInputs(root).sha256) return undefined;
  return booted
    ? `the running test env was booted from other settings than ${TEST_ENV_INPUTS}`
    : `the running test env records no ${TEST_ENV_INPUTS} digest`;
}

/** The descriptor test-env-up.sh wrote, when that environment was booted from the current inputs.
 * The browser seam reads it here, so every spec also reads the inputs Squeal keys it on. */
export function readTestEnvDescriptor(root) {
  const file = resolve(root, '.ai/qa/test-env.json');
  let descriptor;
  try { descriptor = JSON.parse(readFileSync(file, 'utf8')); }
  catch (cause) {
    throw new Error(`cezar e2e: cannot read ${file}. Run \`npm run test:e2e\`, which boots the env first; ` +
      'if it did, the boot failed — see .ai/qa/test-env-app.log and .ai/qa/test-env-build.log.', { cause });
  }
  const mismatch = testEnvInputsMismatch(root, descriptor);
  if (mismatch) throw new Error(`cezar e2e: ${mismatch}. Run .ai/scripts/test-env-up.sh again.`);
  return descriptor;
}

/** `agent-browser --version` prints `agent-browser 0.39.4`; anything without a version is ''. */
export function agentBrowserVersion(output) {
  return /(?:^|\s)v?(\d+\.\d+\.\d+)\s*$/.exec(output)?.[1] ?? '';
}

// CLI for test-env-up.sh: `describe <root>` prints { sha256, agentBrowserVersion, serverEnv },
// `version-of` reads `--version` output on stdin and prints the version.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, root] = process.argv.slice(2);
  try {
    if (command === 'describe' && root) {
      const { inputs, sha256 } = readTestEnvInputs(root);
      process.stdout.write(JSON.stringify({
        sha256, agentBrowserVersion: inputs.browser.agentBrowserVersion, serverEnv: inputs.server.env,
      }) + '\n');
    } else if (command === 'version-of') {
      process.stdout.write(agentBrowserVersion(readFileSync(0, 'utf8')));
    } else {
      console.error('usage: test-env-inputs.mjs describe <root> | version-of');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
