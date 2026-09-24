/**
 * The loopback HTTP half of `cez task` (#504, spec 2026-09-24-cez-task-cli): plain `fetch`
 * against the cockpit's own `/api/v1/p/:projectId` routes, bounded like `cez worker`.
 *
 * No credential is read, sent or printed: the cockpit's origin guard (#426) admits a loopback
 * `Host` with no `Origin`, which is exactly what `fetch` sends.
 */

const RESPONSE_BYTES = 3_145_728;
export const REQUEST_TIMEOUT_MS = 45_000;

/** Every failure carries its exit code and the JSON body the CLI prints. */
export class TaskCliError extends Error {
  constructor(readonly exitCode: number, readonly body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : 'cez task failed');
  }
}

export interface Cockpit {
  /** `http://127.0.0.1:<port>` — no trailing slash. */
  origin: string;
  projectId: string;
  /** `${origin}/api/v1/p/${projectId}` */
  api: string;
}

export function threadUrl(cockpit: Cockpit, runId: string): string {
  return `${cockpit.origin}/p/${encodeURIComponent(cockpit.projectId)}/tasks/${encodeURIComponent(runId)}`;
}

/** Read at most RESPONSE_BYTES, so a hostile or broken server cannot exhaust memory. */
async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

export interface HttpResult { status: number; data: unknown }

/** One request to an absolute URL. JSON bodies are parsed; anything else comes back as text. */
export async function fetchJson(url: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<HttpResult> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      redirect: 'error',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    text = await boundedText(response);
  } catch (error) {
    throw new TaskCliError(2, { code: 'unavailable', error: `cockpit request failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  const json = (response.headers.get('content-type') ?? '').includes('application/json');
  if (!json) return { status: response.status, data: text };
  try {
    return { status: response.status, data: JSON.parse(text) as unknown };
  } catch {
    throw new TaskCliError(2, { code: 'unavailable', error: 'cockpit returned invalid JSON' });
  }
}

/** A project-scoped route: `path` starts with `/`, relative to `/api/v1/p/:projectId`. */
export function request(cockpit: Cockpit, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<HttpResult> {
  return fetchJson(`${cockpit.api}${path}`, init);
}

/** The cockpit said no: pass its `{ error }` through verbatim, exit 2. */
export function refuse(result: HttpResult): never {
  const error = result.data && typeof result.data === 'object' && typeof (result.data as { error?: unknown }).error === 'string'
    ? (result.data as { error: string }).error
    : `cockpit answered HTTP ${result.status}`;
  throw new TaskCliError(2, { code: 'refused', status: result.status, error });
}

/** A response the contract does not describe is a cockpit problem, not a caller problem. */
export function invalidResponse(what: string): never {
  throw new TaskCliError(2, { code: 'unavailable', error: `cockpit returned an unexpected ${what} response` });
}
