import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/windows-workspace-identity.ps1', import.meta.url));

/** A short native operation owns its handles until validation and I/O finish. */
function identityOperation(request: Record<string, unknown>): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024,
  }).trim();
}

export function windowsIdentityDirectory(path: string, create: boolean): void {
  identityOperation({ operation: 'directory', path, create });
}
export function windowsReadIdentity(path: string, cap: number, privateParent = true): string {
  const result = identityOperation({ operation: 'read', path, cap, privateParent });
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result)) throw new Error('Invalid Windows identity response');
  return Buffer.from(result, 'base64').toString('utf8');
}
export function windowsReadEither(legacy: string, current: string, cap: number): string | undefined {
  const result = identityOperation({ operation: 'read-either', legacy, current, cap });
  if (result === '~') return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result)) throw new Error('Invalid Windows identity response');
  return Buffer.from(result, 'base64').toString('utf8');
}
export function windowsWriteIdentity(path: string, content: string, replace = false, privateParent = true): void {
  identityOperation({ operation: 'write', path, content: Buffer.from(content).toString('base64'), replace, privateParent });
}
export function windowsRemoveIdentity(path: string, privateParent = true): void {
  identityOperation({ operation: 'remove', path, privateParent });
}
export function windowsMigrateIdentity(path: string, destination: string): void {
  identityOperation({ operation: 'migrate', path, destination });
}

/** Process identities are obtained from OS handles, never an app lease. */
export function windowsDestroyHolders(paths: readonly string[], pid = 0): Array<{ pid: number; token: string }> {
  const result: unknown = JSON.parse(identityOperation({ operation: 'holders', paths, pid }));
  if (!Array.isArray(result) || !result.every(value => typeof value === 'string' && /^\d+:\d+$/.test(value))) {
    throw new Error('Invalid Windows holder scan');
  }
  return result.map(value => {
    const [id, token] = (value as string).split(':');
    return { pid: Number(id), token: token! };
  });
}

export function windowsStopDestroyHolder(paths: readonly string[], pid: number, token: string): void {
  identityOperation({ operation: 'stop-holder', paths, pid, token });
}
