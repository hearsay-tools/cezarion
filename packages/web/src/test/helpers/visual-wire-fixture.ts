/** Scripted transport provenance: these are supplied public samples, not a DOM
 * evaluation. Echo ONLY the real generated correlation header. Legacy rollback
 * expressions still receive exactly the original bare sample. */
export function scriptedVisualResult(expression: string, value: unknown): unknown {
  if (!expression.startsWith('/*cez-visual:')) return value
  const end = expression.indexOf('*/')
  if (end < 0) throw new Error('malformed scripted visual header')
  let header
  try { header = JSON.parse(expression.slice('/*cez-visual:'.length, end)) }
  catch { throw new Error('malformed scripted visual header') }
  if (!header || Object.keys(header).sort().join(',') !== 'attempt,kind,token,version' || header.version !== 1 || !['visual', 'settled'].includes(header.kind) || typeof header.token !== 'string' || !header.token || !Number.isInteger(header.attempt) || header.attempt < 1) throw new Error('malformed scripted visual header')
  // Original hold fixtures supply changing boxes/focus/value only. Complete
  // their generated layout wire with constant metadata; legacy stays untouched.
  const sample = value as { layout?: object } | null | undefined
  const publicValue = header.kind === 'settled' && sample && typeof sample.layout === 'object' && sample.layout !== null
    ? { ...sample, layout: { text: 'scripted', scrollWidth: 100, viewport: 100, ...sample.layout } } : value
  const measured = (sample as { value?: unknown } | null | undefined)?.value
  const measurementSerialization = typeof measured === 'number' ? (Number.isFinite(measured) ? 'finite-scalar' : 'nonfinite-number') : typeof measured === 'boolean' || typeof measured === 'string' ? 'finite-scalar' : 'opaque'
  return { protocol: 'cez.visual', ...header, public: value === undefined ? { present: false } : { present: true, value: publicValue },
    evidence: { reason: value === null ? 'fonts' : header.kind === 'visual' ? 'visual-ready' : 'sample-ready', phase: value === null || header.kind === 'visual' ? 'visual' : 'measurement',
      ...(value !== null && header.kind === 'settled' ? { measurementSerialization } : {}),
      fontObserved: true, fontStatus: value === null ? 'loading' : 'loaded',
      document: { timeOrigin: 123, path: '/scripted-transport-seam', readyState: 'complete', visibilityState: 'visible', observedAt: header.attempt * 10 },
    },
  }
}
