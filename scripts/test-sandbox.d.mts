export declare const OWNER_FILE: string;
export declare function osTempRoot(): string;
export declare function processAlive(pid: number): boolean;
export declare function reapTestSandboxes(
  prefix: string,
  root?: string,
  options?: {
    alive?: (pid: number) => boolean;
    host?: string;
    account?: { uid?: number };
    now?: () => number;
    unmarkedMaxAgeMs?: number;
    unmarkedLimit?: number;
  },
): string[];
export declare const UNMARKED_MAX_AGE_MS: number;
export declare const UNMARKED_LIMIT: number;
export declare function createTestSandbox(prefix: string, root?: string): string;
export declare function removeTestSandboxes(
  paths: readonly string[],
  remove?: (path: string) => void,
  stop?: (paths: readonly string[]) => unknown,
): void;
export declare function sandboxProcesses(paths: readonly string[], options?: { procRoot?: string; uid?: number }): number[];
export declare function stopSandboxProcesses(
  paths: readonly string[],
  options?: { graceMs?: number; find?: (paths: readonly string[]) => number[] },
): number[];
export declare function hideHostCommands(names: readonly string[], mirrorRoot: string, path?: string): string;
export declare function sharedOmpNativesCache(env?: NodeJS.ProcessEnv): string | undefined;
export declare function linkSharedOmpNatives(home: string, cache?: string): string | undefined;
