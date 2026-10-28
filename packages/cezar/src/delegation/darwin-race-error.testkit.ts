/** Exact osascript failure observed for the no-follow reopen of the symlink. */
export function isSymlinkReopenRefusal(stderr: string): boolean {
  return /^[^\r\n]*: execution error: Error: Error: reopen errno=62 \(-2700\)\s*$/.test(stderr);
}
