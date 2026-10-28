import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, ContentBlock } from './agent-runner.js';

/**
 * Wire helpers that the Pi-family RPC runners share: pi (`pi-runner.ts`) and its fork omp
 * (`omp-runner.ts`) speak the same prompt, message and tool-result shapes
 * (hearsay-tools/cezarion#2006).
 */

/** A cezar prompt as the RPC `prompt` command's message text and images. */
export function toPiPrompt(content: ContentBlock[]): {
  message: string;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
} {
  const text: string[] = [];
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === 'text') text.push(block.text);
    else images.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
  }
  return { message: text.join('\n'), images };
}

export function emitImages(value: unknown, onEvent?: (event: AgentEvent) => void): void {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (isRecord(part) && part.type === 'image') {
      const data = string(part.data);
      const mediaType = string(part.mimeType);
      if (data && mediaType) onEvent?.({ type: 'image', data, mediaType });
    }
  }
}

/** A message's text: a plain string, or its text parts joined like toPiPrompt. */
export function piMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content)
    ? message.content.flatMap(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
    : '';
}

export function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => (isRecord(part) && part.type === 'text' ? string(part.text) : undefined))
    .filter((part): part is string => part !== undefined);
  return text.length > 0 ? text.join('\n') : undefined;
}

export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', resolve));
}

export function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** pi's failure response: the error object's message, the response's message, or a generic line. */
export function piRpcError(value: Record<string, unknown>): string {
  return rpcErrorFor(value, 'pi');
}

/** OMP's failure response carries `error` as a string (rpc-mode.ts, v18.4.11), else as pi's. */
export function ompRpcError(value: Record<string, unknown>): string {
  if (typeof value.error === 'string') return value.error;
  return rpcErrorFor(value, 'omp');
}

function rpcErrorFor(value: Record<string, unknown>, cli: 'pi' | 'omp'): string {
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? string(value.message) ?? `${cli} RPC command ${string(value.command) ?? 'unknown'} failed`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
