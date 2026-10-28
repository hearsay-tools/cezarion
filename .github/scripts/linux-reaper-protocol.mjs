// Pure protocol checks. Importing this module never reads proc or loads the reaper.
import assert from 'node:assert/strict';
import { posix } from 'node:path';

export const WIRE_LIMIT = 64 * 1024;
export const CASES = ['private-bind-closed-fd', 'same-namespace-cwd', 'same-namespace-open-fd',
  'nested-overmount', 'changed-root', 'detached-alias', 'restricted-user'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuid = new RegExp(`^${UUID}$`, 'i');
const token = new RegExp(`^${UUID}:\\d{1,20}$`, 'i');
const decimal = /^\d{1,20}$/;
const namespace = /^(pid|mnt):\[\d{1,20}\]$/;
function fields(value, names) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  assert.deepEqual(Object.keys(value).sort(), names.split(' ').sort(), 'unexpected protocol fields');
}
function text(value, pattern) {
  assert.equal(typeof value, 'string');
  assert(pattern.test(value), 'invalid protocol text');
}
function integer(value, min) {
  assert(Number.isSafeInteger(value) && value >= min && value <= 0x7fffffff, 'invalid protocol integer');
}
function processRecord(value) {
  fields(value, 'pid outerPid startToken uid mountNamespace rootIdentity');
  integer(value.pid, 2); integer(value.outerPid, 2); integer(value.uid, 0);
  text(value.startToken, token); text(value.mountNamespace, /^mnt:\[\d{1,20}\]$/);
  fields(value.rootIdentity, 'dev ino');
  text(value.rootIdentity.dev, decimal); text(value.rootIdentity.ino, decimal);
}
function absolute(value) {
  assert(typeof value === 'string' && value.length <= 4096 && value.startsWith('/') && value !== '/' &&
    !/[\0\r\n]/.test(value) && posix.normalize(value) === value, 'invalid fixture path');
}

export function parseRequest(bytes) {
  assert(Buffer.byteLength(bytes) <= WIRE_LIMIT, 'request exceeds byte limit');
  const value = JSON.parse(bytes);
  fields(value, 'version action case resourceKind fixtureRoot resourceRoot generation resourceId readerUid namespace target sibling');
  assert.equal(value.version, 1);
  assert(CASES.includes(value.case), 'unknown case');
  assert(['observe', 'stop', 'seed', 'retain', 'release'].includes(value.action), 'unknown action');
  assert(['worktree', 'scratch'].includes(value.resourceKind), 'unknown resource kind');
  absolute(value.fixtureRoot); absolute(value.resourceRoot);
  assert.equal(value.resourceRoot, `${value.fixtureRoot}/${value.resourceKind === 'worktree' ? 'owned' : 'scratch'}`);
  text(value.generation, uuid); text(value.resourceId, uuid); integer(value.readerUid, 0);
  fields(value.namespace, 'pid mount outerPid outerMount initStartToken');
  for (const key of ['pid', 'mount', 'outerPid', 'outerMount']) text(value.namespace[key], namespace);
  assert(value.namespace.pid.startsWith('pid:') && value.namespace.outerPid.startsWith('pid:'));
  assert(value.namespace.mount.startsWith('mnt:') && value.namespace.outerMount.startsWith('mnt:'));
  assert.notEqual(value.namespace.pid, value.namespace.outerPid, 'PID namespace not isolated');
  assert.notEqual(value.namespace.mount, value.namespace.outerMount, 'mount namespace not isolated');
  text(value.namespace.initStartToken, token);
  processRecord(value.target); processRecord(value.sibling);
  assert.notEqual(value.target.pid, value.sibling.pid);
  assert.notEqual(value.target.outerPid, value.sibling.outerPid);
  assert.equal(value.target.uid, value.readerUid); assert.equal(value.sibling.uid, value.readerUid);
  if (value.case === 'restricted-user') assert(value.readerUid > 0, 'ordinary-user row cannot run as root');
  if (['seed', 'retain', 'release'].includes(value.action)) assert.equal(value.case, 'detached-alias');
  return value;
}

export function parseMaps(text) {
  assert(Buffer.byteLength(text) <= 4 * 1024 * 1024, 'maps exceeds byte limit');
  return text.split('\n').filter(Boolean).map(line => {
    const match = /^[0-9a-f]+-[0-9a-f]+\s+\S+\s+[0-9a-f]+\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)(?:\s+(.*))?$/i.exec(line);
    assert(match, 'malformed maps');
    return { dev: `${BigInt(`0x${match[1]}`)}:${BigInt(`0x${match[2]}`)}`, ino: match[3], path: match[4] ?? '' };
  });
}

export function validateEvidence(request, target, sibling) {
  assert.equal(sibling.maps, 0, 'sibling maps owned inode');
  assert(!sibling.cwd && !sibling.fds, 'sibling holds owned resource');
  const cwdOnly = request.case === 'same-namespace-cwd';
  const fdOnly = request.case === 'same-namespace-open-fd';
  const released = request.action === 'release';
  assert.equal(target.maps, cwdOnly || fdOnly || released ? 0 : 1, 'mapping fixture is not independent');
  assert.equal(target.cwd, cwdOnly, 'unexpected owned cwd');
  assert.equal(target.fds, fdOnly ? 1 : 0, 'unexpected owned descriptor');
}

// A successful return alone never proves stop-before-delete.
export function verdict(action, { error, targetAlive, siblingAlive, retained, signals }) {
  assert(siblingAlive, 'unrelated sibling did not survive');
  if (action === 'stop') {
    if (error) throw error;
    if (targetAlive) return { status: 'regression', code: 'holder-survived-reap', allowDelete: false, exitCode: 42 };
    assert(signals > 0, 'target exited without a reaper signal');
    assert(!retained, 'stopped target remains retained');
  } else {
    assert(targetAlive, 'non-stop action stopped target');
    assert.equal(signals, 0, 'non-stop action sent a signal');
    if (action === 'seed') {
      assert.equal(error?.message, 'fixture-seeded-before-signal');
      assert(retained, 'seed did not persist retention');
    } else if (action === 'retain') {
      assert(error && /^Cannot verify (?:released alias holder|alias evidence for destroy holder|alias process) \d+$/.test(error.message),
        'retain requires a scoped evidence rejection, not an arbitrary failure');
      assert(retained, 'detached mapping lost retention');
    } else {
      if (error) throw error;
      if (action === 'release') assert(!retained, 'released target remains retained');
    }
  }
  return { status: 'passed', code: `${action}-verified`, allowDelete: ['stop', 'release'].includes(action), exitCode: 0 };
}
