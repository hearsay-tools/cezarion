/** Internal opt-in transport. Unmarked expressions/values never use this codec. */
export type VisualProgram =
  | { mode: 'envelope'; kind: 'visual' | 'settled'; build: (token: string, attempt: number) => string }
  | { mode: 'legacy'; kind: 'settled'; fallback: string }

export const visualReasons = ['missing-target', 'fonts', 'native', 'theme', 'width', 'idle', 'finite-animation', 'zero-box', 'visual-ready', 'measurement-null', 'measurement-undefined', 'sample-ready'] as const
export type VisualReason = typeof visualReasons[number]
export type QualifiedVisualObservation = {
  qualification: 'qualified'
  attempt: number
  reason: VisualReason
  phase: 'visual' | 'measurement'
  fontStatus?: string | null
  document: {
    kind: 'session-timeOrigin-path'
    session: string
    timeOrigin: number
    path: string
    readyState: string
    visibilityState: string
    observedAt: number
  }
}
export type VisualObservation = QualifiedVisualObservation | {
  qualification: 'unqualified-provider-null' | 'missing-provider-result' | 'protocol-error' | 'command-error' | 'legacy-fallback'
  attempt: number
  resultPropertyPresent?: boolean
}
export type VisualPollEvidence = {
  kind: VisualProgram['kind']
  token?: string
  fallback?: string
  latest: VisualObservation | null
  firstQualified: QualifiedVisualObservation | null
  latestQualified: QualifiedVisualObservation | null
  reasons: Partial<Record<VisualReason, number>>
}

export class VisualProtocolError extends Error {
  constructor(field: string) { super(`invalid visual diagnostic envelope: ${field}`); this.name = 'VisualProtocolError' }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
function keys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!object(value) || required.some(key => !owns(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new VisualProtocolError('fields')
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** JSON transport only; public payload is opaque and is neither cloned nor inspected. */
export function decodeVisualSample(raw: unknown, resultPropertyPresent: boolean, expected: { token: string; attempt: number; kind: VisualProgram['kind']; session: string }): { value: unknown; observation: VisualObservation } {
  if (raw === null || raw === undefined) return { value: raw, observation: { qualification: raw === null ? 'unqualified-provider-null' : 'missing-provider-result', attempt: expected.attempt, resultPropertyPresent } }
  keys(raw, ['protocol', 'version', 'token', 'attempt', 'kind', 'public', 'evidence'])
  if (raw.protocol !== 'cez.visual' || raw.version !== 1 || raw.token !== expected.token || raw.attempt !== expected.attempt || raw.kind !== expected.kind) throw new VisualProtocolError('correlation')
  keys(raw.public, ['present'], ['value'])
  if (typeof raw.public.present !== 'boolean' || owns(raw.public, 'value') !== raw.public.present) throw new VisualProtocolError('public presence')
  keys(raw.evidence, ['reason', 'phase', 'fontObserved', 'document'], ['fontStatus'])
  const evidence = raw.evidence
  if (!visualReasons.includes(evidence.reason as VisualReason) || !['visual', 'measurement'].includes(evidence.phase as string)) throw new VisualProtocolError('reason')
  const reason = evidence.reason as VisualReason
  if ((reason.startsWith('measurement-') || reason === 'sample-ready') !== (evidence.phase === 'measurement') || (expected.kind === 'visual' && evidence.phase !== 'visual')) throw new VisualProtocolError('phase')
  if (typeof evidence.fontObserved !== 'boolean' || owns(evidence, 'fontStatus') !== evidence.fontObserved || (evidence.fontObserved && evidence.fontStatus !== null && !text(evidence.fontStatus, 64))) throw new VisualProtocolError('font observation')
  if ((reason === 'missing-target') === evidence.fontObserved) throw new VisualProtocolError('font short-circuit')
  keys(evidence.document, ['timeOrigin', 'path', 'readyState', 'visibilityState', 'observedAt'])
  const doc = evidence.document
  if (!finite(doc.timeOrigin) || !finite(doc.observedAt) || !text(doc.path, 512) || !text(doc.readyState, 32) || !text(doc.visibilityState, 32)) throw new VisualProtocolError('document qualification')
  return { value: raw.public.present ? raw.public.value : undefined, observation: {
    qualification: 'qualified', attempt: expected.attempt, reason, phase: evidence.phase as 'visual' | 'measurement',
    ...(evidence.fontObserved ? { fontStatus: evidence.fontStatus as string | null } : {}),
    document: { kind: 'session-timeOrigin-path', session: expected.session, timeOrigin: doc.timeOrigin, path: doc.path, readyState: doc.readyState, visibilityState: doc.visibilityState, observedAt: doc.observedAt },
  } }
}
