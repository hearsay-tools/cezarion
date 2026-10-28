import { z } from 'zod';
import { askRequestSchema } from './ask-schema.ts';

/** Who may talk: a root and its owned worker (`family`), or two root tasks of one project (`peer`,
 *  spec 2026-10-27-task-communication-protocol § 2). Cezar writes it on peer messages only; an
 *  absent field reads as `family`, so family records stay as older versions wrote them. */
export const conversationRelationshipSchema = z.enum(['family', 'peer']);
export type ConversationRelationship = z.infer<typeof conversationRelationshipSchema>;
export const conversationAttributionSchema = z.object({
  senderRunId: z.uuid(), recipientRunId: z.uuid(),
  kind: z.enum(['request', 'progress', 'follow-up', 'reply']), requestId: z.uuid().optional(),
  relationship: conversationRelationshipSchema.optional(),
}).strict();
export const conversationMessageSchema = conversationAttributionSchema.extend({
  id: z.uuid(), text: z.string().min(1).max(100_000), createdAt: z.iso.datetime(), deadline: z.iso.datetime().optional(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['accepted', 'continuation-required', 'destroyed', 'late']),
  /** A parent-authorized new execution; retained on exact message retries. */
  resumed: z.literal(true).optional(),
  instruction: z.string().max(2048).optional(),
  /** A worker's question routed to its parent (#505): answered only by a reply naming it. */
  question: askRequestSchema.optional(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export const requestOutcomeSchema = z.object({
  requestId: z.uuid(), /** `deleted`: a peer recipient's record was deleted while the request was open. */
  status: z.enum(['replied', 'replied-late', 'completed-without-reply', 'failed', 'cancelled', 'destroyed', 'timed-out', 'sender-closed', 'human-fallback', 'deleted']),
  observedAt: z.iso.datetime(), replyId: z.uuid().optional(),
}).strict();
export type RequestOutcome = z.infer<typeof requestOutcomeSchema>;
export const conversationStateSchema = z.object({ messages: z.array(conversationMessageSchema).max(1024), outcomes: z.array(requestOutcomeSchema).max(1024) }).strict();
export type ConversationState = z.infer<typeof conversationStateSchema>;
/** A history page boundary in the merged `(createdAt, id)` order: opaque to agents, one rule here. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const conversationCursorSchema = z.string().max(128).regex(CURSOR, 'Not a history cursor; pass nextBefore from an earlier page');
export function encodeConversationCursor(message: { createdAt: string; id: string }): string { return `${message.createdAt}~${message.id}`; }
export function decodeConversationCursor(cursor: string): { createdAt: string; id: string } {
  const match = CURSOR.exec(cursor);
  if (!match) throw new Error('Not a history cursor');
  return { createdAt: match[1]!, id: match[2]! };
}
/** The merged history page bound: the newest 1,024 messages of a pair, which may span two ledgers. */
export const CONVERSATION_PAGE_MESSAGES = 1024;
export const conversationInspectResultSchema = conversationStateSchema.extend({ hint: z.string().optional(),
  /** Present when older messages exist: pass it as `before` to read the page before this one. */
  nextBefore: conversationCursorSchema.optional() });
export type ConversationInspectResult = z.infer<typeof conversationInspectResultSchema>;

export const inboxReserveResultSchema = z.object({
  messages: z.array(conversationMessageSchema).max(32), outcomes: z.array(requestOutcomeSchema).max(32),
  receiptId: z.uuid().optional(), expiresAt: z.iso.datetime().optional(),
}).strict().refine(value => value.messages.length > 0
  ? value.receiptId !== undefined && value.expiresAt !== undefined
  : value.receiptId === undefined && value.expiresAt === undefined,
{ message: 'A nonempty inbox batch requires a receipt and expiry' });
export type InboxReserveResult = z.infer<typeof inboxReserveResultSchema>;
export const inboxReceiptRequestSchema = z.object({ receiptId: z.uuid() }).strict();
export type InboxReceiptRequest = z.infer<typeof inboxReceiptRequestSchema>;
export const inboxReceiptResultSchema = z.object({
  receiptId: z.uuid(), status: z.enum(['acknowledged', 'already-acknowledged', 'released']),
}).strict();
export type InboxReceiptResult = z.infer<typeof inboxReceiptResultSchema>;
/** Resume rounds may outlast ordinary message exchanges; waits keep their own shorter bound. */
export const MAX_RESUME_REQUEST_SECONDS = 86_400;
export const MAX_CONVERSATION_REQUEST_SECONDS = 1_800;
export const DEFAULT_CONVERSATION_REQUEST_SECONDS = 600;
export const conversationSendRequestSchema = z.object({
  id: z.uuid(), recipientRunId: z.uuid(), kind: conversationAttributionSchema.shape.kind,
  requestId: z.uuid().optional(), text: z.string().min(1).max(100_000).refine(text => text.trim().length > 0), timeoutSeconds: z.number().int().min(1).max(MAX_RESUME_REQUEST_SECONDS).default(DEFAULT_CONVERSATION_REQUEST_SECONDS),
  resume: z.boolean().optional(),
}).strict().refine(value => value.timeoutSeconds <= MAX_CONVERSATION_REQUEST_SECONDS || (value.resume === true && value.kind === 'request'), { path: ['timeoutSeconds'], message: 'Only --resume requests accept deadlines above 1800 seconds (maximum 86400)' })
  .refine(value => (value.kind === 'reply' || value.kind === 'follow-up') === (value.requestId !== undefined), { message: 'Replies and follow-ups require a request ID; new messages must omit it' })
  .refine(value => !value.resume || value.kind === 'request' || value.kind === 'progress', { message: '--resume requires a new request or progress instruction' });
export type ConversationSendRequest = z.infer<typeof conversationSendRequestSchema>;
/** `consumed`: the recipient's harness reported the model read it (#505). */
export const conversationSendResultSchema = z.object({ message: conversationMessageSchema, delivery: z.enum(['queued', 'delivered', 'consumed', 'not-delivered']), outcome: requestOutcomeSchema.optional() }).strict();
export type ConversationSendResult = z.infer<typeof conversationSendResultSchema>;
export const conversationInspectRequestSchema = z.object({ recipientRunId: z.uuid(), before: conversationCursorSchema.optional() }).strict();
export type ConversationInspectRequest = z.infer<typeof conversationInspectRequestSchema>;
export const conversationCancelRequestSchema = z.object({ requestId: z.uuid() }).strict();
export type ConversationCancelRequest = z.infer<typeof conversationCancelRequestSchema>;
export const requestWaitRequestSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(32).refine(ids => new Set(ids).size === ids.length),
  mode: z.enum(['one', 'any', 'all']).optional(), timeoutSeconds: z.number().int().min(1).max(1800).default(600),
}).strict().refine(value => value.mode !== 'one' || value.requestIds.length === 1, { message: 'one requires exactly one request' });
export type RequestWaitRequest = z.infer<typeof requestWaitRequestSchema>;
