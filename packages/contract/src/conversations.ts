import { z } from 'zod';

export const conversationAttributionSchema = z.object({
  senderRunId: z.uuid(), recipientRunId: z.uuid(),
  kind: z.enum(['request', 'progress', 'follow-up', 'reply']), requestId: z.uuid().optional(),
}).strict();
export const conversationMessageSchema = conversationAttributionSchema.extend({
  id: z.uuid(), text: z.string().min(1).max(100_000), createdAt: z.iso.datetime(), deadline: z.iso.datetime().optional(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['accepted', 'continuation-required', 'destroyed', 'late']),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export const requestOutcomeSchema = z.object({
  requestId: z.uuid(), status: z.enum(['replied', 'completed-without-reply', 'failed', 'cancelled', 'destroyed', 'timed-out', 'sender-closed']),
  observedAt: z.iso.datetime(), replyId: z.uuid().optional(),
}).strict();
export type RequestOutcome = z.infer<typeof requestOutcomeSchema>;
export const conversationStateSchema = z.object({ messages: z.array(conversationMessageSchema).max(1024), outcomes: z.array(requestOutcomeSchema).max(1024) }).strict();
export type ConversationState = z.infer<typeof conversationStateSchema>;
export const conversationSendRequestSchema = z.object({
  id: z.uuid(), recipientRunId: z.uuid(), kind: conversationAttributionSchema.shape.kind,
  requestId: z.uuid().optional(), text: z.string().min(1).max(100_000).refine(text => text.trim().length > 0), timeoutSeconds: z.number().int().min(1).max(1800).default(600),
}).strict().refine(value => (value.kind === 'reply' || value.kind === 'follow-up') === (value.requestId !== undefined), { message: 'Replies and follow-ups require a request ID; new messages must omit it' });
export type ConversationSendRequest = z.infer<typeof conversationSendRequestSchema>;
export const conversationSendResultSchema = z.object({ message: conversationMessageSchema, delivery: z.enum(['queued', 'delivered', 'not-delivered']), outcome: requestOutcomeSchema.optional() }).strict();
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
