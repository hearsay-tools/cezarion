// No top-level I/O. All proc reads name self, PID1, or an explicit fixture PID.
import assert from 'node:assert/strict';
import { closeSync, lstatSync, openSync, opendirSync, readSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { parseMaps, validateEvidence } from './linux-reaper-protocol.mjs';

export function readBounded(path, limit = 4 * 1024 * 1024) {
  const fd = openSync(path, 'r');
  try {
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) return Buffer.concat(chunks).toString('utf8');
      size += count;
      assert(size <= limit, 'native evidence exceeds byte limit');
      chunks.push(chunk.subarray(0, count));
    }
  } finally { closeSync(fd); }
}
export function identity(path, follow = true) {
  const info = (follow ? statSync : lstatSync)(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
}
function device(dev) {
  const n = BigInt(dev);
  return `${((n >> 8n) & 0xfffn) | ((n >> 32n) & 0xfffff000n)}:${(n & 0xffn) | ((n >> 12n) & 0xffffff00n)}`;
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function status(pid) { return readBounded(`/proc/${pid}/status`, 16384); }
function numericStatus(content, name) {
  const value = content.match(new RegExp(`^${name}:\\s+(.+)$`, 'm'))?.[1];
  assert(value, `missing ${name}`);
  return value.trim().split(/\s+/).map(Number);
}
export function incarnation(pid) {
  const content = readBounded(`/proc/${pid}/stat`, 16384);
  const tail = content.slice(content.lastIndexOf(')') + 1).trim().split(/\s+/);
  assert(/^\d+$/.test(tail[19] ?? ''), 'invalid process start time');
  const boot = readBounded('/proc/sys/kernel/random/boot_id', 128).trim();
  return { token: `${boot}:${tail[19]}`, alive: !['Z', 'X', 'x'].includes(tail[0]) };
}
export function processState(record) {
  try {
    const current = incarnation(record.pid);
    assert.equal(current.token, record.startToken, 'fixture PID reused');
    return { pid: record.pid, outerPid: record.outerPid, startToken: record.startToken, alive: current.alive };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { pid: record.pid, outerPid: record.outerPid, startToken: record.startToken, alive: false };
  }
}
export function assertProcess(record) {
  assert(processState(record).alive, 'fixture process is not live');
  assert.equal(readlinkSync(`/proc/${record.pid}/ns/pid`), readlinkSync('/proc/self/ns/pid'));
  assert.equal(readlinkSync(`/proc/${record.pid}/ns/mnt`), record.mountNamespace);
  assert.deepEqual(identity(`/proc/${record.pid}/root`), record.rootIdentity);
  assert(numericStatus(status(record.pid), 'Uid').every(uid => uid === record.uid), 'fixture UID changed');
}

export function guard(request) {
  assert.equal(process.platform, 'linux');
  assert(process.pid > 1 && process.ppid === 1, 'reader must be a direct child of namespace init');
  assert.equal(process.getuid(), request.readerUid); assert.equal(process.geteuid(), request.readerUid);
  const mounts = readBounded('/proc/self/mountinfo');
  assert(!/\s(?:shared|master|propagate_from):\d+/.test(mounts), 'mount propagation is not private');
  const fixtureIdentity = identity(request.fixtureRoot, false);
  const resourceIdentity = identity(request.resourceRoot, false);
  const assertCurrent = () => {
    assert.equal(readlinkSync('/proc/self'), String(process.pid), 'proc does not match PID namespace');
    assert.deepEqual(numericStatus(status('self'), 'NSpid'), [process.pid], 'proc exposes outer PID view');
    assert.deepEqual(numericStatus(status(1), 'NSpid'), [1], 'proc lacks local namespace init');
    assert.equal(readlinkSync('/proc/self/ns/pid'), request.namespace.pid);
    assert.equal(readlinkSync('/proc/self/ns/mnt'), request.namespace.mount);
    assert.equal(incarnation(1).token, request.namespace.initStartToken);
    assert.equal(readBounded('/proc/self/mountinfo'), mounts, 'reader mounts changed');
    for (const [path, expected] of [[request.fixtureRoot, fixtureIdentity], [request.resourceRoot, resourceIdentity]]) {
      const info = lstatSync(path);
      assert(info.isDirectory() && !info.isSymbolicLink(), 'unsafe fixture directory');
      assert.equal(realpathSync(path), path, 'redirected fixture directory');
      assert.equal(info.uid, request.readerUid, 'fixture ownership changed');
      assert.deepEqual(identity(path, false), expected, 'fixture inode changed');
    }
    assert.equal(lstatSync(request.fixtureRoot).mode & 0o777, 0o700);
    if (request.readerUid > 0) {
      const capabilities = status('self').match(/^CapEff:\s+([0-9a-f]+)$/mi)?.[1];
      assert(capabilities && BigInt(`0x${capabilities}`) === 0n, 'ordinary reader has capabilities');
    }
  };
  assertCurrent(); assertProcess(request.target); assertProcess(request.sibling);
  assert.notEqual(request.target.pid, process.pid); assert.notEqual(request.sibling.pid, process.pid);
  return assertCurrent;
}

function fdIdentities(pid) {
  const result = [];
  const directory = opendirSync(`/proc/${pid}/fd`);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) return result;
      assert(result.length < 256, 'fixture descriptor count exceeds limit');
      result.push(identity(`/proc/${pid}/fd/${entry.name}`));
    }
  } finally { directory.closeSync(); }
}
export function assertFixtureEvidence(request) {
  const expectedPath = `${request.resourceRoot}/${request.case === 'nested-overmount' ? 'nested/mapped' : 'mapped'}`;
  const file = identity(expectedPath);
  const root = identity(request.resourceRoot);
  // The Python fixture creates these exact entries for every row. Include both
  // files so a top-level mapping cannot make the nested-only row pass.
  const known = [root, identity(`${request.resourceRoot}/mapped`),
    identity(`${request.resourceRoot}/nested`), identity(`${request.resourceRoot}/nested/mapped`)];
  const matches = record => {
    const maps = parseMaps(readBounded(`/proc/${record.pid}/maps`));
    return {
      maps: maps.filter(map => known.some(item => device(item.dev) === map.dev && item.ino === map.ino)),
      cwd: known.some(item => same(item, identity(`/proc/${record.pid}/cwd`))),
      fds: fdIdentities(record.pid).filter(fd => known.some(item => same(item, fd))),
    };
  };
  const target = matches(request.target), sibling = matches(request.sibling);
  const unrelated = identity(`${request.fixtureRoot}/sibling/mapped`);
  assert.equal(unrelated.dev, file.dev, 'sibling must test the same device');
  assert.notEqual(unrelated.ino, file.ino, 'sibling must map a distinct inode');
  const siblingMaps = parseMaps(readBounded(`/proc/${request.sibling.pid}/maps`));
  assert.equal(siblingMaps.filter(map => map.dev === device(unrelated.dev) && map.ino === unrelated.ino).length, 1,
    'sibling mapping is missing');
  assert(!fdIdentities(request.sibling.pid).some(fd => same(fd, unrelated)), 'sibling mapping descriptor remains open');
  const summary = value => ({ maps: value.maps.length, fds: value.fds.length, cwd: value.cwd });
  validateEvidence(request, summary(target), summary(sibling));
  if (target.maps.length) assert.equal(target.maps[0].ino, file.ino);
  return { ownedMappings: target.maps.length, ownedDescriptors: target.fds.length, ownedCwd: target.cwd,
    sameDeviceSiblingMapping: true };
}
