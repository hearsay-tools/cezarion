import { z } from 'zod';
import { askRequestSchema } from './ask-schema.ts';

export const conversationAttributionSchema = z.object({
  senderRunId: z.uuid(), recipientRunId: z.uuid(),
  kind: z.enum(['request', 'progress', 'follow-up', 'reply']), requestId: z.uuid().optional(),
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
  requestId: z.uuid(), status: z.enum(['replied', 'completed-without-reply', 'failed', 'cancelled', 'destroyed', 'timed-out', 'sender-closed', 'human-fallback']),
  observedAt: z.iso.datetime(), replyId: z.uuid().optional(),
}).strict();
export type RequestOutcome = z.infer<typeof requestOutcomeSchema>;
export const conversationStateSchema = z.object({ messages: z.array(conversationMessageSchema).max(1024), outcomes: z.array(requestOutcomeSchema).max(1024) }).strict();
export type ConversationState = z.infer<typeof conversationStateSchema>;
export const conversationInspectResultSchema = conversationStateSchema.extend({ hint: z.string().optional() });
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
export const conversationSendRequestSchema = z.object({
  id: z.uuid(), recipientRunId: z.uuid(), kind: conversationAttributionSchema.shape.kind,
  requestId: z.uuid().optional(), text: z.string().min(1).max(100_000).refine(text => text.trim().length > 0), timeoutSeconds: z.number().int().min(1).max(1800).default(600),
  resume: z.boolean().optional(),
}).strict().refine(value => (value.kind === 'reply' || value.kind === 'follow-up') === (value.requestId !== undefined), { message: 'Replies and follow-ups require a request ID; new messages must omit it' })
  .refine(value => !value.resume || value.kind === 'request' || value.kind === 'progress', { message: '--resume requires a new request or progress instruction' });
export type ConversationSendRequest = z.infer<typeof conversationSendRequestSchema>;
/** `consumed`: the recipient's harness reported the model read it (#505). */
export const conversationSendResultSchema = z.object({ message: conversationMessageSchema, delivery: z.enum(['queued', 'delivered', 'consumed', 'not-delivered']), outcome: requestOutcomeSchema.optional() }).strict();
export type ConversationSendResult = z.infer<typeof conversationSendResultSchema>;
export const conversationInspectRequestSchema = z.object({ recipientRunId: z.uuid() }).strict();
export type ConversationInspectRequest = z.infer<typeof conversationInspectRequestSchema>;
export const conversationCancelRequestSchema = z.object({ requestId: z.uuid() }).strict();
export type ConversationCancelRequest = z.infer<typeof conversationCancelRequestSchema>;
export const requestWaitRequestSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(32).refine(ids => new Set(ids).size === ids.length),
  mode: z.enum(['one', 'any', 'all']).optional(), timeoutSeconds: z.number().int().min(1).max(1800).default(600),
}).strict().refine(value => value.mode !== 'one' || value.requestIds.length === 1, { message: 'one requires exactly one request' });
export type RequestWaitRequest = z.infer<typeof requestWaitRequestSchema>;
