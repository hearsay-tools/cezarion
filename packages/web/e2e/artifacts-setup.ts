import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Specs write evidence straight into this folder, and only a screenshot used to create it, so a
// spec that wrote before any screenshot failed with ENOENT (hearsay-tools/squawk#3494).
mkdirSync(resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e'), { recursive: true })
