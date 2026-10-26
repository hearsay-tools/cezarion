import { startAndForget } from './detached-process.ts';

/** Open `url` in the user's browser; a missing opener is silently fine (the URL is printed). */
export function openUrl(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  // A missing opener (e.g. no `xdg-open` on a headless Linux VPS) resolves false, and the start
  // keeps nothing alive. The URL is printed above, so a browser-less host just doesn't auto-open.
  void startAndForget(cmd, args);
}
