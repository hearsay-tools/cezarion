import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

/**
 * SIGHUP is acted on only when Squawk runs on a terminal. GNU `nohup` moves stdin and stdout
 * off the terminal, so `nohup cez serve` is not on one. Node resets SIGHUP to its default at
 * startup, discarding the ignore disposition `nohup` set, so off a terminal Squawk ignores
 * hangups itself (hearsay-tools/cezarion#915).
 */
export function onTerminal(): boolean {
  return process.platform !== 'win32' && (Boolean(process.stdin.isTTY) || Boolean(process.stdout.isTTY));
}

export function ignoreHangupOffTerminal(): void {
  if (process.platform !== 'win32' && !onTerminal()) process.on('SIGHUP', () => {});
}

/** Acquire once, on the actual bind host; --port 0 delegates selection to the OS. */
export async function acquireServeListener(port: number, bindHost = '127.0.0.1'): Promise<Server> {
  const listener = createServer((_request, response) => {
    response.writeHead(503, { 'Content-Type': 'text/plain', 'Connection': 'close' });
    response.end('Cockpit is starting; retry shortly.\n');
  });
  try {
    listener.listen(port, bindHost);
    await once(listener, 'listening');
    return listener;
  } catch (error) {
    listener.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `Cockpit port ${port} on ${bindHost} is already in use. ` +
        'Open the existing cockpit if it is serving there, stop the process using this port, ' +
        'or pass --port <free-port> to deliberately start another cockpit.',
      );
    }
    throw error;
  }
}

export async function waitForHealth(healthUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

