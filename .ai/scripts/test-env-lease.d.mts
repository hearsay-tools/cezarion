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
