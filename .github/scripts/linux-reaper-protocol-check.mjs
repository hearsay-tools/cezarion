// Safe local replay: pure protocol/evidence assertions; no native module import.
import assert from 'node:assert/strict';
import { auditSignal, parseRequest, parseMaps, validateEvidence, verdict, WIRE_LIMIT } from './linux-reaper-protocol.mjs';

let checked = 0;
function check(name, fn) { fn(); checked++; console.log(`PASS ${name}`); }
const uuid = '00000000-0000-4000-8000-000000000001';
const processRecord = (pid, outerPid) => ({ pid, outerPid, startToken: `${uuid}:123`, uid: 0,
  mountNamespace: 'mnt:[2]', rootIdentity: { dev: '2050', ino: '2' } });
const request = {
  version: 1, action: 'stop', case: 'private-bind-closed-fd', resourceKind: 'worktree',
  fixtureRoot: '/fixture/row', resourceRoot: '/fixture/row/owned', generation: uuid, resourceId: uuid,
  readerUid: 0, namespace: { pid: 'pid:[2]', mount: 'mnt:[2]', outerPid: 'pid:[1]', outerMount: 'mnt:[1]', initStartToken: `${uuid}:10` },
  target: processRecord(2, 200), sibling: processRecord(3, 300),
};
const parse = value => parseRequest(JSON.stringify(value));
const state = { targetAlive: false, siblingAlive: true, retained: false, signals: 1 };
const empty = { maps: 0, fds: 0, cwd: false };

check('non-stop signal attempts are recorded but never forwarded', () => {
  for (const action of ['observe', 'seed', 'retain', 'release']) {
    const attempts = []; let forwarded = 0;
    assert.throws(() => auditSignal({ ...request, action }, attempts, request.target.pid, 'SIGTERM', () => {}, () => { forwarded++; }));
    assert.deepEqual(attempts, [{ pid: request.target.pid, signal: 'SIGTERM' }]);
    assert.equal(forwarded, 0);
  }
  const attempts = []; let forwarded = 0;
  auditSignal(request, attempts, request.target.pid, 'SIGTERM', () => {}, () => { forwarded++; });
  assert.equal(forwarded, 1);
});

check('local and external process attribution stay separate', () => {
  const value = parse(request);
  assert.equal(value.target.pid, 2); assert.equal(value.target.outerPid, 200);
});
check('wrong resource roots and unknown fields are rejected', () => {
  assert.throws(() => parse({ ...request, resourceRoot: '/fixture/sibling' }));
  assert.throws(() => parse({ ...request, checkpoint: '/arbitrary/file' }));
  assert.throws(() => parse({ ...request, fixtureRoot: '/fixture/../row' }));
});
check('missing namespace isolation is rejected', () => {
  assert.throws(() => parse({ ...request, namespace: { ...request.namespace, pid: 'pid:[1]' } }));
  assert.throws(() => parse({ ...request, namespace: { ...request.namespace, mount: 'mnt:[1]' } }));
});
check('PID1, shared handles and malformed identities are rejected', () => {
  for (const target of [{ ...request.target, pid: 1 }, { ...request.target, pid: 3 },
    { ...request.target, outerPid: 300 }, { ...request.target, startToken: '123' },
    { ...request.target, uid: 1 }, { ...request.target, rootIdentity: { dev: 2050, ino: '2' } }]) {
    assert.throws(() => parse({ ...request, target }));
  }
});
check('ordinary-user row cannot be substituted with root', () => {
  assert.throws(() => parse({ ...request, case: 'restricted-user' }));
  parse({ ...request, case: 'restricted-user', readerUid: 65534,
    target: { ...request.target, uid: 65534 }, sibling: { ...request.sibling, uid: 65534 } });
});
check('protocol bounds and phase combinations reject malformed input', () => {
  assert.throws(() => parseRequest(' '.repeat(WIRE_LIMIT + 1)));
  assert.throws(() => parseRequest(JSON.stringify(request) + '\n{}'));
  assert.throws(() => parse({ ...request, action: 'retain' }));
  for (const action of ['seed', 'retain', 'release']) parse({ ...request, action, case: 'detached-alias' });
});
check('sanitized maps replay uses exact device and inode', () => {
  assert.deepEqual(parseMaps('1000-2000 r--p 00000000 08:02 123 /private alias/mapped\n'),
    [{ dev: '8:2', ino: '123', path: '/private alias/mapped' }]);
  assert.throws(() => parseMaps('not a maps record'));
});
check('mapping-only row rejects hidden cwd or descriptors', () => {
  validateEvidence(request, { ...empty, maps: 1 }, empty);
  assert.throws(() => validateEvidence(request, { ...empty, maps: 1, cwd: true }, empty));
  assert.throws(() => validateEvidence(request, { ...empty, maps: 1, fds: 1 }, empty));
  assert.throws(() => validateEvidence(request, { ...empty, maps: 2 }, empty));
});
check('cwd-only and fd-only reject the old mapping confound', () => {
  for (const [name, evidence] of [['same-namespace-cwd', { ...empty, cwd: true }],
    ['same-namespace-open-fd', { ...empty, fds: 1 }]]) {
    validateEvidence({ case: name, action: 'stop' }, evidence, empty);
    assert.throws(() => validateEvidence({ case: name, action: 'stop' }, { ...evidence, maps: 1 }, empty));
  }
});
check('release and sibling must have no owned mapping', () => {
  validateEvidence({ case: 'detached-alias', action: 'release' }, empty, empty);
  assert.throws(() => validateEvidence({ case: 'detached-alias', action: 'release' }, { ...empty, maps: 1 }, empty));
  assert.throws(() => validateEvidence(request, { ...empty, maps: 1 }, { ...empty, maps: 1 }));
});
check('legacy reaper normal return with live target is the exact proof failure', () => {
  assert.deepEqual(verdict('stop', { ...state, targetAlive: true, signals: 0 }),
    { status: 'regression', code: 'holder-survived-reap', allowDelete: false, exitCode: 42 });
});
check('capability/import/budget failures cannot become proof failures', () => {
  for (const message of ['EPERM', 'module not found', 'alias scan work exceeds bounds']) {
    assert.throws(() => verdict('stop', { ...state, targetAlive: true, error: new Error(message) }));
    assert.throws(() => verdict('retain', { ...state, targetAlive: true, signals: 0, retained: true, error: new Error(message) }));
  }
});
check('stop requires real signal, target exit, sibling survival and cleared retention', () => {
  assert.equal(verdict('stop', state).allowDelete, true);
  for (const change of [{ signals: 0 }, { siblingAlive: false }, { retained: true }]) {
    assert.throws(() => verdict('stop', { ...state, ...change }));
  }
});
check('observation never authorizes deletion and must send no signals', () => {
  assert.equal(verdict('observe', { ...state, targetAlive: true, signals: 0 }).allowDelete, false);
  assert.throws(() => verdict('observe', { ...state, targetAlive: true }));
});
check('retention phases require persisted proof, live processes and zero signals', () => {
  for (const [action, message] of [['seed', 'fixture-seeded-before-signal'], ['retain', 'Cannot verify released alias holder 2']]) {
    const value = { ...state, signals: 0, targetAlive: true, retained: true, error: new Error(message) };
    assert.equal(verdict(action, value).allowDelete, false);
    for (const change of [{ signals: 1 }, { retained: false }, { targetAlive: false }, { error: undefined }]) {
      assert.throws(() => verdict(action, { ...value, ...change }));
    }
  }
});
check('release clears checkpoint without stopping target', () => {
  const value = { ...state, targetAlive: true, signals: 0 };
  assert.equal(verdict('release', value).allowDelete, true);
  assert.throws(() => verdict('release', { ...value, retained: true }));
  assert.throws(() => verdict('release', { ...value, targetAlive: false }));
});
console.log(`Pure protocol replay: ${checked} checks passed; no native execution.`);
