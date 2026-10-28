import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Cdp, CdpConnection } from './cdp.ts';
import { ChromiumError, launchChromium, resolveChromium } from './chromium.ts';

/** A task's Chromium as the preview host launches it (#781): resolve, launch, attach to its page. Split out of `host.ts`. */

const PROFILE_RELEASE_WAIT_MS = 5_000;
const STDERR_TAIL_CHARS = 4096;

export type BrowserExit = { signal?: string; exitCode?: number; stderrTail: string };
/** A launched Chromium: its page's CDP session, and the browser connection the agent's proxy
 *  opens its own sessions on (hearsay-tools/cezarion#784). `exited` settles when the process is gone. */
export type BrowserHandle = { cdp: Cdp; connection: CdpConnection; pageTargetId?: string | undefined; exited: Promise<BrowserExit>; close(): void };

/** No Chromium anywhere `resolveChromium` looks: the pane offers the download or the OS command. */
export class ChromiumMissingError extends Error {}

const targetsSchema = z.object({ targetInfos: z.array(z.object({ type: z.string(), targetId: z.string() }).passthrough()) });
export const attachedSchema = z.object({ sessionId: z.string() });

/** A closed browser's exit, bounded: a profile is deleted only once Chromium let go of it. */
export async function waitForExit(browser: BrowserHandle): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([browser.exited, new Promise<void>(resolve => (timer = setTimeout(resolve, PROFILE_RELEASE_WAIT_MS)))]);
  clearTimeout(timer);
}

/** resolve → launch → a flat session on the page target. */
export async function launchBrowser(profileDir: string, env: NodeJS.ProcessEnv): Promise<BrowserHandle> {
  const bin = resolveChromium(undefined, env);
  if (!bin) throw new ChromiumMissingError('No Chromium found');
  const { proc, browser: connection } = await launchChromium(bin, profileDir, env);
  let tail = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<BrowserExit>(resolve =>
    proc.once('exit', (code, signal) => resolve({ ...(signal ? { signal } : code !== null ? { exitCode: code } : {}), stderrTail: tail })),
  );
  try {
    const root = connection.session(undefined);
    const { targetInfos } = targetsSchema.parse(await root.send('Target.getTargets'));
    const page = targetInfos.find(target => target.type === 'page');
    if (!page) throw new ChromiumError('exited', tail, 'Chromium opened no page');
    const { sessionId } = attachedSchema.parse(await root.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }));
    const cdp = connection.session(sessionId);
    return { cdp, connection, pageTargetId: page.targetId, exited, close: () => { connection.close(); proc.kill(); } };
  } catch (error) {
    connection.close();
    proc.kill('SIGKILL');
    throw error;
  }
}

export function readOsRelease(): string {
  try {
    return readFileSync('/etc/os-release', 'utf8');
  } catch {
    return '';
  }
}
