import { createHash } from 'node:crypto';
import type { ConversationMessage, Wait } from '@open-mercato/cezar-contract';
import type { RunEvent } from '../runs/store.ts';
import { describeWait, isCezarHumanWait } from '../workflows/waits.ts';
import { uuidFrom } from './questions.ts';
import { topLevelAssistantText } from './results.ts';

/** How much of the worker's last message a park notice quotes. */
export const PARK_NOTICE_EXCERPT_MAX = 1000;

/**
 * A parent waiting on a worker wakes only on its outcome or the wait's deadline, so a worker that
 * parks before finishing leaves its parent asleep (hearsay-tools/cezarion#1327). Cezar then tells
 * the parent itself, as a progress message from the worker: it wakes the parent and closes no
 * wait. The ID derives from the worker and the parent's wait, so one wait gets at most one notice
 * from each worker, and posting it again after a restart finds the same message.
 */
export function parkNoticeId(workerRunId: string, waitId: string): string {
  return uuidFrom(`worker-park:${workerRunId}:${waitId}`);
}

/** The turn the worker parked in: when it started, and its last top-level assistant text. An
 *  event log without a `turn.started` gives no start, and the whole log is that turn. */
export function parkingTurn(events: readonly RunEvent[]): { startedAt?: string; text?: string } {
  let text: string | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'turn.started') return { startedAt: event.ts, ...(text === undefined ? {} : { text }) };
    const said = text === undefined ? topLevelAssistantText(event) : undefined;
    if (said?.trim()) text = said;
  }
  return text === undefined ? {} : { text };
}

/** The worker's own words, without Cezar's control lines, cut to `PARK_NOTICE_EXCERPT_MAX`. */
export function parkNoticeExcerpt(text: string): string | undefined {
  const prose = text.split('\n').filter(line => !line.trim().startsWith('CEZ:')).join('\n').trim();
  if (!prose) return undefined;
  return prose.length > PARK_NOTICE_EXCERPT_MAX ? `${prose.slice(0, PARK_NOTICE_EXCERPT_MAX)}…` : prose;
}

/** What the parent reads: who parked, what it waits on, what it last said, and what to do next. */
export function formatParkNoticeText(input: { workerRunId: string; waitId: string; waits: readonly Wait[]; lastText?: string }): string {
  // A worker parked on a question gets no notice; its question reaches the parent instead.
  const open = input.waits.filter(wait => wait.phase === 'open' && wait.kind !== 'human' && !isCezarHumanWait(wait));
  const excerpt = input.lastText === undefined ? undefined : parkNoticeExcerpt(input.lastText);
  return [
    `Cezar notice: your worker ${input.workerRunId} parked before finishing. Your wait ${input.waitId} stays open; this message closes no wait.`,
    open.length ? `It waits on: ${open.map(describeWait).join('; ')}.` : 'It has no open wait: it waits for a message from you.',
    ...(excerpt === undefined ? [] : ['Its last message:', excerpt]),
    `Check it with worker inspect ${input.workerRunId}, or instruct it with worker send ${input.workerRunId} '<instruction>' --id <new-message-UUID>.`,
  ].join('\n');
}

export function parkNoticeMessage(input: {
  workerRunId: string; parentRunId: string; waitId: string; waits: readonly Wait[]; lastText?: string; now: string; redact(text: string): string;
}): ConversationMessage {
  const id = parkNoticeId(input.workerRunId, input.waitId);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ senderRunId: input.workerRunId, recipientRunId: input.parentRunId, parkNotice: input.waitId }))
    .digest('hex');
  return { id, senderRunId: input.workerRunId, recipientRunId: input.parentRunId, kind: 'progress',
    text: input.redact(formatParkNoticeText(input)), createdAt: input.now, requestHash, state: 'accepted' };
}
