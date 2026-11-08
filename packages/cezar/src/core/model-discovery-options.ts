import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Common host model-probe inputs; each backend keeps its own public type name. */
export interface ModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, args: readonly string[], cwd: string) => ChildProcessWithoutNullStreams;
}
