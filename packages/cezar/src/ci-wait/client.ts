import { request } from 'node:http';
import { previewStopResult } from '../preview/registration.ts';
import { previewRefusal } from './errors.ts';
import { cezarAskAnswerSchema, cezarCancelWaitAnswerSchema, cezarDoneAnswerSchema, cezarWaitAnswerSchema, type CezarAskAnswer, type CezarCancelWaitAnswer, type CezarDoneAnswer, type CezarWaitAnswer } from '@open-mercato/cezar-contract/waits';
import { previewServeResultSchema, previewStopResultSchema, type PreviewStopResult, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';

const UNAVAILABLE = 'CI tool unavailable: the owning session is closed or the private IPC connection failed.';
/**
 * #781: posts the arguments unparsed, so the server names the failing field in its hint. Every
 * transport failure, refusal or unreadable answer becomes the typed `unavailable` result; this
 * never throws.
 */
export function callPreviewServe(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<PreviewServeResult> {
  return callTool(input, env, 'preview-serve', previewServeResultSchema, previewRefusal('unavailable'));
}

export function callPreviewStop(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<PreviewStopResult> {
  return callTool(input, env, 'preview-stop', previewStopResultSchema, previewStopResult('unavailable'));
}

/** hearsay-tools/cezarion#1233: unparsed like preview, so the server names the failing field. */
export function callCezarWait(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<CezarWaitAnswer> {
  return callTool(input, env, 'wait', cezarWaitAnswerSchema, { ok: false, code: 'unavailable', message: UNAVAILABLE });
}

export function callCezarCancelWait(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<CezarCancelWaitAnswer> {
  return callTool(input, env, 'cancel-wait', cezarCancelWaitAnswerSchema, { cancelled: false, code: 'unavailable', message: UNAVAILABLE });
}

/** hearsay-tools/cezarion#1234: unparsed too, so the server names an unknown field. */
export function callCezarDone(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<CezarDoneAnswer> {
  return callTool(input, env, 'done', cezarDoneAnswerSchema, { ok: false, code: 'unavailable', message: UNAVAILABLE });
}

/** hearsay-tools/cezarion#1234: unparsed too, so the server names the failing question. */
export function callCezarAsk(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<CezarAskAnswer> {
  return callTool(input, env, 'ask', cezarAskAnswerSchema, { ok: false, code: 'unavailable', message: UNAVAILABLE });
}

function callTool<T>(input: unknown, env: NodeJS.ProcessEnv, route: string, schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, unavailable: T): Promise<T> {
  const socketPath = env.CEZ_TOOL_SOCKET; const token = env.CEZ_TOOL_TOKEN;
  if (!socketPath || !token) return Promise.resolve(unavailable);
  return new Promise(resolve => {
    const req = request({ socketPath, path: `/api/v1/tools/${route}`, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 32768) req.destroy(); else chunks.push(chunk); });
      response.on('error', () => resolve(unavailable));
      response.on('end', () => {
        try {
          const result = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          resolve(response.statusCode === 200 && result.success ? result.data : unavailable);
        } catch { resolve(unavailable); }
      });
    });
    req.setTimeout(15000, () => req.destroy());
    req.on('error', () => resolve(unavailable));
    req.end(JSON.stringify(input ?? null));
  });
}

/**
 * Controller pipe death (including SIGKILL) bounds the adapter's lifetime. The GET keeps its
 * historical `ci-wait` path; the POST of the removed `cezar_wait_for_ci` (hearsay-tools/cezarion#1236) is gone.
 */
export function monitorCiOwner(onClose: () => void, env: NodeJS.ProcessEnv = process.env): () => void {
  let stopped = false;
  const close = () => { if (!stopped) { stopped = true; onClose(); } };
  if (!env.CEZ_TOOL_SOCKET || !env.CEZ_TOOL_TOKEN) { queueMicrotask(close); return () => { stopped = true; }; }
  const req = request({ socketPath: env.CEZ_TOOL_SOCKET, path: '/api/v1/tools/ci-wait', headers: { authorization: `Bearer ${env.CEZ_TOOL_TOKEN}` } }, response => {
    if (response.statusCode !== 200) { response.resume(); close(); return; }
    response.resume(); response.on('end', close); response.on('error', close); response.on('close', close);
  });
  req.on('error', close); req.end();
  return () => { stopped = true; req.destroy(); };
}
