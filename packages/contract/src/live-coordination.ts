import { z } from 'zod'
import { liveRunDemandSchema, liveRunFrameSchema } from './live.ts'

export const LIVE_PROTOCOL = 1
export const LIVE_WORKER_NAME = 'cezar-live-v1'
export const LEASE_MS = 15_000
export const RENEW_MS = 5_000

/** Only periodic public cockpit GET families; never arbitrary URLs or mutation execution. */
export function allowedLiveRead(path: string): boolean {
  if (!path.startsWith('/api/v1/') || path.includes('#') || /[\\\r\n]/.test(path)) return false
  return /^\/api\/v1\/(?:workspace\/(?:runs-index|skills-update)|p\/[a-zA-Z0-9_-]+\/(?:runs\/[a-zA-Z0-9._-]+\/(?:changes|commits)|github(?:\/(?:checks|ref-status))?))(?:\?[^#]*)?$/.test(path)
}
export const liveDemandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }),
  liveRunDemandSchema.extend({ kind: z.literal('run') }),
  z.object({ kind: z.literal('topic'), topic: z.string().min(1).max(128) }),
  // Preserve server-directed cadence (settled references use ten minutes). Only
  // bound the timer itself: larger delays overflow setTimeout into a tight loop.
  z.object({ kind: z.literal('read'), path: z.string().max(4096).refine(allowedLiveRead), intervalMs: z.number().int().min(1_000).max(2_147_483_647) }),
])
export type LiveDemand = z.infer<typeof liveDemandSchema>
export const liveEntrySchema = z.object({ id: z.string().min(1).max(128), demand: liveDemandSchema })
const envelope = z.object({ version: z.literal(LIVE_PROTOCOL), documentId: z.string().min(1).max(128), epoch: z.number().int().nonnegative() })
export const ownerInputSchema = z.discriminatedUnion('type', [
  envelope.extend({ type: z.literal('sync'), entries: z.array(liveEntrySchema).max(64) }).refine(value => new Set(value.entries.map(e => e.id)).size === value.entries.length),
  envelope.extend({ type: z.literal('ack'), id: z.string(), seq: z.number().int().nonnegative() }),
  envelope.extend({ type: z.literal('refresh'), id: z.string() }),
])
export type OwnerInput = z.infer<typeof ownerInputSchema>
export const wireFrameSchema = z.object({ event: z.string(), data: z.string(), id: z.string() })
export const ownerOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unavailable'), version: z.literal(LIVE_PROTOCOL), epoch: z.number(), reason: z.string() }),
  z.object({ type: z.literal('hello'), version: z.literal(LIVE_PROTOCOL) }),
  z.object({ type: z.literal('alive'), version: z.literal(LIVE_PROTOCOL), epoch: z.number() }),
  z.object({ type: z.literal('frame'), version: z.literal(LIVE_PROTOCOL), epoch: z.number(), id: z.string(), frame: z.union([wireFrameSchema, liveRunFrameSchema]) }),
  z.object({ type: z.literal('value'), version: z.literal(LIVE_PROTOCOL), epoch: z.number(), id: z.string(), value: z.unknown(), error: z.string().optional() }),
  z.object({ type: z.literal('reset'), version: z.literal(LIVE_PROTOCOL), epoch: z.number(), id: z.string(), reason: z.string() }),
])
export type OwnerOutput = z.infer<typeof ownerOutputSchema>
export type LiveFrame = z.infer<typeof wireFrameSchema> | z.infer<typeof liveRunFrameSchema>
export const runKey = (run: { projectId: string; runId: string }) => `${run.projectId}/${run.runId}`
