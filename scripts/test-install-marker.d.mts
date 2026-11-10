export function ensureTestInstallMarker(root: string): void;
export function protectedRootsFor(accountHome: string, env: { TMPDIR?: string | undefined }, platform: NodeJS.Platform): string[];
export function accountProtectedRoots(): string[];
export function insideRoot(destination: string, root: string, platform: NodeJS.Platform): boolean;
