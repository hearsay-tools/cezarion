import { afterEach } from 'vitest'

import { highlighterSettledForTests } from '@/lib/highlighter'

// Drain any cold Shiki load a case started so it cannot run into the next case's waitFor
// budget (#601; measured 223ms vs 62ms on the Files-tab snapshot case). Free when nothing
// highlighted: settling an empty list resolves on the next microtask.
afterEach(() => highlighterSettledForTests())
