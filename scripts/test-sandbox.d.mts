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
  },
): string[];
export declare function createTestSandbox(prefix: string, root?: string): string;
export declare function removeTestSandboxes(paths: readonly string[], remove?: (path: string) => void): void;
export declare function sharedOmpNativesCache(env?: NodeJS.ProcessEnv): string | undefined;
export declare function linkSharedOmpNatives(home: string, cache?: string): string | undefined;
