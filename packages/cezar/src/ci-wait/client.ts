import { request } from 'node:http';
import { previewStopResult } from '../preview/registration.ts';
import { previewRefusal } from './errors.ts';
import { ciWaitRequestSchema, ciWaitReceiptSchema, ciWaitErrorSchema, previewServeResultSchema, previewStopResultSchema, type PreviewStopResult, type CiWaitReceipt, type PreviewServeResult } from '@open-mercato/cezar-contract';

const UNAVAILABLE = 'CI tool unavailable: the owning session is closed or the private IPC connection failed.';
export async function callCiWait(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<CiWaitReceipt> {
  const parsed = ciWaitRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid CI wait arguments: provide a GitHub PR URL and optional timeout_seconds (1–7200).');
  const socketPath = env.CEZ_TOOL_SOCKET; const token = env.CEZ_TOOL_TOKEN;
  if (!socketPath || !token) throw new Error(UNAVAILABLE);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/api/v1/tools/ci-wait', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 32768) req.destroy(new Error(UNAVAILABLE)); else chunks.push(chunk); });
      response.on('error', () => reject(new Error(UNAVAILABLE)));
      response.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) {
            const error = ciWaitErrorSchema.safeParse(body);
            reject(new Error(error.success ? `${error.data.code}: ${error.data.message}` : UNAVAILABLE));
            return;
          }
          resolve(ciWaitReceiptSchema.parse(body));
        } catch { reject(new Error(UNAVAILABLE)); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error(UNAVAILABLE)));
    req.on('error', () => reject(new Error(UNAVAILABLE)));
    req.end(JSON.stringify(parsed.data));
  });
}

/**
 * #781: posts the arguments unparsed, so the server names the failing field in its hint. Every
 * transport failure, refusal or unreadable answer becomes the typed `unavailable` result; this
 * never throws.
 */
export function callPreviewServe(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<PreviewServeResult> {
  return callPreview(input, env, 'preview-serve', previewServeResultSchema, previewRefusal('unavailable'));
}

export function callPreviewStop(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<PreviewStopResult> {
  return callPreview(input, env, 'preview-stop', previewStopResultSchema, previewStopResult('unavailable'));
}

function callPreview<T>(input: unknown, env: NodeJS.ProcessEnv, route: string, schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, unavailable: T): Promise<T> {
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

/** Controller pipe death (including SIGKILL) bounds the adapter's lifetime. */
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
