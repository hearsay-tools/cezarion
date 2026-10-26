export const OWNER_FILE: string;
export function osTempRoot(): string;
export function processAlive(pid: number): boolean;
export function reapTestSandboxes(
  prefix: string,
  root?: string,
  options?: { alive?: (pid: number) => boolean; host?: string },
): string[];
export function createTestSandbox(prefix: string, root?: string): string;
export function removeTestSandboxes(paths: readonly string[], remove?: (path: string) => void): void;
export function sharedOmpNativesCache(env?: NodeJS.ProcessEnv): string | undefined;
export function linkSharedOmpNatives(home: string, cache?: string): string | undefined;
