import { posix, win32 } from 'node:path';

/**
 * True when `path` is absolute on this host: `/srv/repo` on POSIX; `C:\repo`, `C:/repo` or
 * `\\server\share\repo` on Windows. Reads the platform at each call, so a test can stub it.
 */
export function isAbsoluteHostPath(path: string): boolean {
  return (process.platform === 'win32' ? win32 : posix).isAbsolute(path);
}
