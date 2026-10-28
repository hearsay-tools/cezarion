import { expect, it } from 'vitest';
import { assertCapacityEvidence, prepareCapacityFixture, type CapacityEvidence } from './authoritative-capacity-guard.testkit.ts';

function evidence(): CapacityEvidence {
  const info = (canonical: string) => ({ canonical, directory: true, symlink: false, uid: 0, mode: 0o700 });
  return { directory: '/private/capacity', root: '/private', script: '/repo/.github/scripts/linux-mount-alias-probe.py',
    argv: ['/python', '/repo/.github/scripts/linux-mount-alias-probe.py', '--child', '/private', '3', 'mnt:[old]', '-1', '-1', '/node', 'pid:[old]'],
    uid: 0, pid: 50, nspid: ['NSpid:', '50'], initNspid: ['NSpid:', '1'], pidNamespace: 'pid:[new]', initPidNamespace: 'pid:[new]',
    mountNamespace: 'mnt:[new]', initMountNamespace: 'mnt:[new]', rootInfo: info('/private'), capacityInfo: info('/private/capacity'), mountInfo: '1 0 8:1 / / rw - ext4 root rw', tmpdir: '/global-sandbox' };
}

it('repins only after authentication and checks equality at fixture entry', () => {
  const e = evidence(); const events: string[] = [];
  expect(() => assertCapacityEvidence(e, true)).toThrow(); // old fixture rejects the global setup overwrite
  prepareCapacityFixture(() => { events.push('read'); return e; }, path => { events.push('pin'); e.tmpdir = path; });
  events.push('fixture'); assertCapacityEvidence(e, true);
  expect(events).toEqual(['read', 'pin', 'read', 'fixture']);
});

it.each([
  ['forged script', (e: CapacityEvidence) => { e.argv[1] = '/elsewhere/linux-mount-alias-probe.py'; }],
  ['wrong args', (e: CapacityEvidence) => { e.argv[2] = '--bootstrap'; }],
  ['outside pid namespace', (e: CapacityEvidence) => { e.pidNamespace = e.argv[9]!; e.initPidNamespace = e.pidNamespace; }],
  ['pid namespace mismatch', (e: CapacityEvidence) => { e.initPidNamespace = 'other'; }],
  ['outside mount namespace', (e: CapacityEvidence) => { e.mountNamespace = e.argv[5]!; e.initMountNamespace = e.mountNamespace; }],
  ['mount namespace mismatch', (e: CapacityEvidence) => { e.initMountNamespace = 'other'; }],
  ['nonroot', (e: CapacityEvidence) => { e.uid = 1; }],
  ['shared', (e: CapacityEvidence) => { e.mountInfo = '1 0 8:1 / / rw shared:1 - ext4 root rw'; }],
  ['master', (e: CapacityEvidence) => { e.mountInfo = '1 0 8:1 / / rw master:1 - ext4 root rw'; }],
  ['symlink', (e: CapacityEvidence) => { e.capacityInfo.symlink = true; }],
  ['noncanonical', (e: CapacityEvidence) => { e.capacityInfo.canonical = '/other'; }],
  ['wrong root', (e: CapacityEvidence) => { e.argv[3] = '/other'; }],
  ['wrong capacity', (e: CapacityEvidence) => { e.directory = '/other'; }],
  ['wrong owner', (e: CapacityEvidence) => { e.rootInfo.uid = 1; }],
  ['wrong mode', (e: CapacityEvidence) => { e.capacityInfo.mode = 0o755; }],
] as const)('rejects %s before env mutation or fixture', (_, mutate) => {
  const e = evidence(); mutate(e); let pinned = false, fixture = false;
  expect(() => { prepareCapacityFixture(() => e, () => { pinned = true; }); fixture = true; }).toThrow();
  expect(pinned).toBe(false); expect(fixture).toBe(false);
});

it('refuses a changed fixture on the second guard', () => {
  const e = evidence(); let reads = 0;
  expect(() => prepareCapacityFixture(() => { if (++reads === 2) e.rootInfo.uid = 1; return e; }, path => { e.tmpdir = path; })).toThrow();
});
