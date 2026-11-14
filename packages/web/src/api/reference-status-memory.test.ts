import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  window.sessionStorage.clear()
})

// hearsay-tools/squawk#2923: the module-load restore read its storage keys before they were
// declared, and its try/catch turned the ReferenceError into "nothing remembered".
it('restores the remembered statuses and conflicts when the module loads', async () => {
  window.sessionStorage.setItem('cez.reference-statuses.v1', JSON.stringify([['api\u0000PR#774', 'merged']]))
  window.sessionStorage.setItem('cez.reference-conflicts.v1', JSON.stringify(['api\u0000PR#775']))
  vi.resetModules()

  const memory = await import('./reference-status-memory')

  expect([...memory.rememberedStatuses]).toEqual([['api\u0000PR#774', 'merged']])
  expect([...memory.rememberedConflicts]).toEqual(['api\u0000PR#775'])
})
