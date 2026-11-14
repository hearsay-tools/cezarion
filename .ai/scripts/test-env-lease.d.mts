export declare function acquireTestEnvLease(root: string, options?: {
  token?: string;
  pid?: number;
  group?: boolean | string;
  timeoutMs?: number;
  onWait?: (message: string) => void;
}): Promise<{ token: string; release(): void }>;

export declare function describeTestEnvHolders(holders: readonly { pid: number; start?: string | null }[], probes?: {
  now?: () => number;
  deadline?: number;
  identify?: (pid: number, timeoutMs: number) => { start?: string; dead?: boolean };
  command?: (pid: number, timeoutMs: number) => string[] | { text: string } | undefined;
}): { owners: string; guidance: string };

export declare function identity(pid: number, timeout?: number): { dead?: boolean; start?: string };

export type LeaseIdentity = { start?: string; dead?: boolean };
export type WindowsProbe = (mode: string, payload: string, timeout?: number) => string | undefined;
export type TestEnvHolder = { id: string; token: string; pid: number; start: string | null;
  pgid?: number | string | null; diagnosticVerified?: boolean };

export declare function leaseIdentity(pid: number, timeout?: number, probe?: WindowsProbe): LeaseIdentity;
export declare function leaseGroupLive(pgid: number | string, probe?: WindowsProbe): boolean | undefined;
export declare function reclaimTestEnvHolders(db: import('node:sqlite').DatabaseSync, identity: (pid: number) => LeaseIdentity,
  groupLive: (pgid: number | string) => boolean | undefined): TestEnvHolder[];
