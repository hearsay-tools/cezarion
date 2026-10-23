// Native delivery controls belong to the mock, not to source-rewriting test helpers.
// Only configured mocks import this module, so an unconfigured mock keeps its exact
// event-loop order. The control changes timing only: what a turn says still follows
// its input, and each mock writes its own native rejection and acknowledgement.
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const ENV = 'CEZ_MOCK_DELIVERY_CONTROL';
const KINDS = ['reject', 'hold-ack', 'hold-response'];

function validate(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected a control object');
  const keys = config.kind === 'reject' ? ['kind', 'match', 'persistent'] : ['kind', 'match'];
  if (KINDS.includes(config.kind) && typeof config.match === 'string' && config.match.trim()
    && (config.persistent === undefined || typeof config.persistent === 'boolean')
    && Object.keys(config).every(key => keys.includes(key))) return config;
  throw new Error('expected reject (optionally persistent), hold-ack or hold-response with a nonempty match');
}

/** Fixture setup and handles use the same marker paths as the mock reader. The
 * fixture owns cleanup; none of this state depends on a native subprocess cwd. */
export function createDeliveryControl(root, options) {
  const path = join(resolve(root), 'native-delivery-control.json');
  writeFileSync(path, JSON.stringify(validate(options)));
  return {
    path,
    held: () => existsSync(`${path}.held`),
    release: () => writeFileSync(`${path}.released`, ''),
    lift: () => writeFileSync(`${path}.lifted`, ''),
  };
}

/** Read once at mock startup. A configured but broken fixture must never fall
 * through to an ordinary native turn. Absence is handled by each mock before
 * importing, so its ordinary scheduling stays unchanged. */
export function readDeliveryControl(supportedKinds) {
  const path = process.env[ENV];
  let config;
  try {
    if (!path || !isAbsolute(path)) throw new Error('expected an absolute control path');
    config = validate(JSON.parse(readFileSync(path, 'utf8')));
    if (!supportedKinds.includes(config.kind)) throw new Error(`this native mock does not support ${config.kind}`);
  } catch (error) {
    throw new Error(`${ENV}: ${error.message}`, { cause: error });
  }
  const matches = (kind, text) => config.kind === kind && typeof text === 'string' && text.includes(config.match);
  const released = () => existsSync(`${path}.released`);
  return {
    kind: config.kind,
    rejects(text) {
      if (!matches('reject', text) || existsSync(`${path}.lifted`)) return false;
      if (config.persistent) return true;
      // More than one matching input can arrive in a fixture. Exactly one claims
      // the rejection, including when the inputs reach different subprocesses.
      try { closeSync(openSync(`${path}.rejected`, 'wx')); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      return true;
    },
    ack(text, send) {
      if (!matches('hold-ack', text) || released()) { send(); return; }
      writeFileSync(`${path}.held`, '');
      const timer = setInterval(() => { if (released()) { clearInterval(timer); send(); } }, 5);
    },
    holdResponse(text) {
      if (!matches('hold-response', text) || released()) return undefined;
      writeFileSync(`${path}.held`, '');
      return (async () => { while (!released()) await new Promise(resolve => setTimeout(resolve, 5)); })();
    },
  };
}
