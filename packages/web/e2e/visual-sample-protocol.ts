/** Internal opt-in transport. Unmarked expressions/values never use this codec. */
export type VisualProgram =
  | { mode: 'envelope'; kind: 'visual' | 'settled'; build: (token: string, attempt: number) => string }
  | { mode: 'legacy'; kind: 'settled'; fallback: string }

export const visualReasons = ['missing-target', 'fonts', 'native', 'theme', 'width', 'idle', 'finite-animation', 'zero-box', 'visual-ready', 'measurement-null', 'measurement-undefined', 'sample-ready'] as const
export type VisualReason = typeof visualReasons[number]
type MeasurementSerialization = 'finite-scalar' | 'nonfinite-number' | 'opaque'
export type QualifiedVisualObservation = {
  qualification: 'qualified'
  attempt: number
  reason: VisualReason
  phase: 'visual' | 'measurement'
  fontStatus?: string | null
  measurementSerialization?: MeasurementSerialization
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

/** Only the generated signature is structural; never inspect measured value. */
function visualSignature(value: unknown): void {
  keys(value, ['boxes', 'text', 'scrollWidth', 'viewport'])
  const number = (coordinate: unknown) => typeof coordinate === 'number' && Number.isFinite(coordinate)
  if (!Array.isArray(value.boxes) || !value.boxes.every(box => Array.isArray(box) && box.length === 4 && box.every(number))
    || (value.text !== null && typeof value.text !== 'string') || !number(value.scrollWidth) || !number(value.viewport)) {
    throw new VisualProtocolError('visual signature')
  }
}

function generatedRoot(kind: VisualProgram['kind'], reason: VisualReason, publicSlot: Record<string, unknown>): void {
  if (publicSlot.present !== true) throw new VisualProtocolError('generated public presence')
  if (kind === 'settled' && ['theme', 'width', 'idle', 'visual-ready'].includes(reason)) throw new VisualProtocolError('generated kind/reason')
  if (reason === 'visual-ready') visualSignature(publicSlot.value)
  else if (reason === 'sample-ready') {
    keys(publicSlot.value, ['layout', 'focus', 'value'])
    visualSignature(publicSlot.value.layout)
    if (typeof publicSlot.value.focus !== 'number' || !Number.isInteger(publicSlot.value.focus) || publicSlot.value.focus < -1) throw new VisualProtocolError('focus index')
    // The own value slot is opaque: false/zero and provider-serialized nested
    // Promise/thenable objects keep their original identity and semantics.
  } else if (publicSlot.value !== null) throw new VisualProtocolError('rejection public value')
}

/** Original scalar category is observed before JSON. Opaque toJSON results can
 * legitimately be null; this is consistency evidence, not wire authentication. */
function measurementSerialization(reason: VisualReason, evidence: Record<string, unknown>, publicValue: unknown): void {
  if ((reason === 'sample-ready') !== owns(evidence, 'measurementSerialization')) throw new VisualProtocolError('measurement qualification presence')
  if (reason !== 'sample-ready') return
  const category = evidence.measurementSerialization
  if (!['finite-scalar', 'nonfinite-number', 'opaque'].includes(category as string)) throw new VisualProtocolError('measurement qualification')
  const value = (publicValue as Record<string, unknown>).value
  if (value === undefined
    || (category === 'finite-scalar' && !(typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)))
    || (category === 'nonfinite-number' && value !== null)) throw new VisualProtocolError('measurement serialization')
}

/** JSON transport only; nested measured payload is neither cloned nor inspected. */
export function decodeVisualSample(raw: unknown, resultPropertyPresent: boolean, expected: { token: string; attempt: number; kind: VisualProgram['kind']; session: string }): { value: unknown; observation: VisualObservation } {
  if (raw === null || raw === undefined) return { value: raw, observation: { qualification: raw === null ? 'unqualified-provider-null' : 'missing-provider-result', attempt: expected.attempt, resultPropertyPresent } }
  keys(raw, ['protocol', 'version', 'token', 'attempt', 'kind', 'public', 'evidence'])
  if (raw.protocol !== 'cez.visual' || raw.version !== 1 || raw.token !== expected.token || raw.attempt !== expected.attempt || raw.kind !== expected.kind) throw new VisualProtocolError('correlation')
  keys(raw.public, ['present'], ['value'])
  if (typeof raw.public.present !== 'boolean' || owns(raw.public, 'value') !== raw.public.present) throw new VisualProtocolError('public presence')
  keys(raw.evidence, ['reason', 'phase', 'fontObserved', 'document'], ['fontStatus', 'measurementSerialization'])
  const evidence = raw.evidence
  if (!visualReasons.includes(evidence.reason as VisualReason) || !['visual', 'measurement'].includes(evidence.phase as string)) throw new VisualProtocolError('reason')
  const reason = evidence.reason as VisualReason
  if ((reason.startsWith('measurement-') || reason === 'sample-ready') !== (evidence.phase === 'measurement') || (expected.kind === 'visual' && evidence.phase !== 'visual')) throw new VisualProtocolError('phase')
  if (typeof evidence.fontObserved !== 'boolean' || owns(evidence, 'fontStatus') !== evidence.fontObserved || (evidence.fontObserved && evidence.fontStatus !== null && !text(evidence.fontStatus, 64))) throw new VisualProtocolError('font observation')
  if ((reason === 'missing-target') === evidence.fontObserved) throw new VisualProtocolError('font short-circuit')
  if (evidence.fontObserved && (reason === 'fonts' ? evidence.fontStatus === 'loaded' : evidence.fontStatus !== 'loaded')) throw new VisualProtocolError('font branch')
  generatedRoot(expected.kind, reason, raw.public)
  measurementSerialization(reason, evidence, raw.public.value)
  keys(evidence.document, ['timeOrigin', 'path', 'readyState', 'visibilityState', 'observedAt'])
  const doc = evidence.document
  if (!finite(doc.timeOrigin) || !finite(doc.observedAt) || !text(doc.path, 512) || !text(doc.readyState, 32) || !text(doc.visibilityState, 32)) throw new VisualProtocolError('document qualification')
  return { value: raw.public.present ? raw.public.value : undefined, observation: {
    qualification: 'qualified', attempt: expected.attempt, reason, phase: evidence.phase as 'visual' | 'measurement',
    ...(reason === 'sample-ready' ? { measurementSerialization: evidence.measurementSerialization as MeasurementSerialization } : {}),
    ...(evidence.fontObserved ? { fontStatus: evidence.fontStatus as string | null } : {}),
    document: { kind: 'session-timeOrigin-path', session: expected.session, timeOrigin: doc.timeOrigin, path: doc.path, readyState: doc.readyState, visibilityState: doc.visibilityState, observedAt: doc.observedAt },
  } }
}
