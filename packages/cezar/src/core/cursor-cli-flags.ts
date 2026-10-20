/** Every Cursor CLI process cezar starts passes this hidden commander option, so starting
 * one never self-updates the installed CLI (hearsay-tools/cezarion#1257). 2026.10.01-e373342
 * and 2026.10.16-e3cb207 define it with `hideHelp`; `--help` cannot show whether a build has it. */
export const CURSOR_DISABLE_AUTO_UPDATE = '--disable-auto-update';

/** Binaries that exited with commander's unknown-option error for the flag. Process-lifetime:
 * the CLI can only change under a binary when something other than cezar updates it. */
const rejecting = new Set<string>();

export function usesCursorAutoUpdateFlag(bin: string): boolean {
  return !rejecting.has(bin);
}

export function cursorArgs(bin: string, args: readonly string[]): string[] {
  return usesCursorAutoUpdateFlag(bin) ? [CURSOR_DISABLE_AUTO_UPDATE, ...args] : [...args];
}

/** Commander exits 1 with this line before any work, so retrying without the flag is safe. */
export function rejectsCursorAutoUpdateFlag(output: string): boolean {
  return output.includes(`unknown option '${CURSOR_DISABLE_AUTO_UPDATE}'`);
}

export function noteCursorAutoUpdateFlagRejected(bin: string): void {
  rejecting.add(bin);
}

export function resetCursorAutoUpdateFlagCache(): void {
  rejecting.clear();
}

/** A launch exited because this build rejects the flag; the caller retries without it. */
export class CursorAutoUpdateFlagRejected extends Error {
  constructor() { super('Cursor CLI rejected --disable-auto-update'); }
}

/** Keeps a bounded stderr tail, never surfaced, to tell the flag rejection apart. */
export function watchCursorAutoUpdateRejection(stderr: NodeJS.ReadableStream): () => boolean {
  let tail = '';
  stderr.on('data', (chunk: Buffer | string) => { tail = (tail + chunk.toString()).slice(-1_024); });
  return () => rejectsCursorAutoUpdateFlag(tail);
}

/** Runs `launch` once; when the build rejects the flag, records that and runs it once more,
 * now without the flag. `launch` must build its argv through `cursorArgs(bin, …)`. */
export async function withCursorAutoUpdateFallback<T>(bin: string, launch: () => Promise<T>): Promise<T> {
  try { return await launch(); }
  catch (error) {
    if (!(error instanceof CursorAutoUpdateFlagRejected) || !usesCursorAutoUpdateFlag(bin)) throw error;
    noteCursorAutoUpdateFlagRejected(bin);
    return launch();
  }
}
