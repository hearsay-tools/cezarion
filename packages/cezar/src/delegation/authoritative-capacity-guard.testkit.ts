import { join } from 'node:path';

type DirectoryEvidence = { canonical: string; directory: boolean; symlink: boolean; uid: number; mode: number };
export type CapacityEvidence = {
  directory: string; root: string; script: string; argv: string[]; uid: number | undefined; pid: number;
  nspid: string[] | undefined; initNspid: string[] | undefined;
  pidNamespace: string; initPidNamespace: string; mountNamespace: string; initMountNamespace: string;
  rootInfo: DirectoryEvidence; capacityInfo: DirectoryEvidence; mountInfo: string; tmpdir: string | undefined;
};

function supervised(e: CapacityEvidence): boolean {
  return e.argv.length === 10 && e.argv[1] === e.script && e.argv[2] === '--child' && e.argv[3] === e.root &&
    !!e.root && e.directory === join(e.root, 'capacity') && e.rootInfo.canonical === e.root &&
    e.capacityInfo.canonical === e.directory && e.uid === 0;
}

function privateNamespaces(e: CapacityEvidence): boolean {
  return e.nspid?.length === 2 && e.nspid[1] === String(e.pid) && e.initNspid?.length === 2 && e.initNspid[1] === '1' &&
    e.pidNamespace === e.initPidNamespace && e.mountNamespace === e.initMountNamespace &&
    e.pidNamespace !== e.argv[9] && e.mountNamespace !== e.argv[5];
}

/** Pure guard; all evidence is collected before a test can change TMPDIR. */
export function assertCapacityEvidence(e: CapacityEvidence, requireTmp: boolean): void {
  if (!supervised(e) || !privateNamespaces(e)) throw Error('capacity test requires the supervised private PID namespace');
  for (const info of [e.rootInfo, e.capacityInfo]) {
    if (!info.directory || info.symlink || info.uid !== 0 || (info.mode & 0o777) !== 0o700) throw Error('capacity fixture is not private');
  }
  if (e.mountInfo.split('\n').some(line => /(?:^| )(?:shared|master):\d+/.test(line.split(' - ', 1)[0] ?? ''))) throw Error('mount propagation is not private');
  if (requireTmp && e.tmpdir !== e.directory) throw Error('capacity fixture path changed');
}

/** Authenticate before mutating the environment; repeat the entire guard after. */
export function prepareCapacityFixture(read: () => CapacityEvidence, pin: (directory: string) => void): void {
  const first = read();
  assertCapacityEvidence(first, false);
  pin(first.directory);
  assertCapacityEvidence(read(), true);
}
