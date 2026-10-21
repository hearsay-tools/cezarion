// Native failure controls belong to the mock, not to source-rewriting test helpers.
// Only configured mocks import this module. Persistent decisions are synchronous:
// in particular, Claude's unread exit must not yield to another stdin line.
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const ENV = 'CEZ_MOCK_FAILURE_CONTROL';
const GATED_PROMPTS = ['mock:auth-error', 'mock:provider-error', 'Resume to receive the queued CI observation.'];
const FAILURES = ['provider', 'usage-limit', 'unread'];

function validate(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected a control object');
  if (config.mode === 'gated-once' && Object.keys(config).every(key => key === 'mode')) return config;
  if (config.mode === 'persistent' && typeof config.opening === 'string' && config.opening.trim()
    && FAILURES.includes(config.failure) && Object.keys(config).every(key => ['mode', 'opening', 'failure'].includes(key))) return config;
  throw new Error('expected gated-once, or persistent with a nonempty opening and provider/usage-limit/unread failure');
}

/** Fixture setup and handles use the same marker paths as the mock reader. The
 * fixture owns cleanup; none of this state depends on a native subprocess cwd. */
export function createFailureControl(root, options) {
  const path = join(resolve(root), 'native-failure-control.json');
  writeFileSync(path, JSON.stringify(validate(options)));
  return {
    path,
    held: () => existsSync(`${path}.held`),
    release: () => writeFileSync(`${path}.released`, ''),
    lift: () => writeFileSync(`${path}.lifted`, ''),
  };
}

/** Read once at mock startup. A configured but broken fixture must never fall
 * through to a successful native turn. Absence is handled by each mock before
 * importing, so its ordinary scheduling stays unchanged. */
export function readFailureControl(supportedFailures = ['provider']) {
  const path = process.env[ENV];
  let config;
  try {
    if (!path || !isAbsolute(path)) throw new Error('expected an absolute control path');
    config = validate(JSON.parse(readFileSync(path, 'utf8')));
    const failure = config.mode === 'gated-once' ? 'provider' : config.failure;
    if (!supportedFailures.includes(failure)) throw new Error(`this native mock does not support ${failure}`);
  } catch (error) {
    throw new Error(`${ENV}: ${error.message}`, { cause: error });
  }
  const failure = config.mode === 'gated-once' ? 'provider' : config.failure;
  return {
    failure,
    failureFor(text) {
      if (typeof text !== 'string') return undefined;
      if (config.mode === 'persistent') {
        return text.includes(config.opening) && !existsSync(`${path}.lifted`) ? failure : undefined;
      }
      if (existsSync(`${path}.failed`) || !GATED_PROMPTS.some(prompt => text.includes(prompt))) return undefined;
      return gatedFailure();
    },
  };

  async function gatedFailure() {
    writeFileSync(`${path}.held`, '');
    while (!existsSync(`${path}.released`)) await new Promise(resolve => setTimeout(resolve, 5));
    // More than one matching run can be held in a fixture. Exactly one claims
    // the failure, including when the runs belong to different subprocesses.
    try { closeSync(openSync(`${path}.failed`, 'wx')); }
    catch (error) { if (error.code === 'EEXIST') return undefined; throw error; }
    return failure;
  }
}
