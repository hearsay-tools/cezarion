import { writeFileSync } from 'node:fs'
import { runEventSchema } from '@open-mercato/cezar-api-client'

/** Validate every nonblank NDJSON line before writing any of the seeded transcript. */
export function seedTranscript(path: string, transcript: string): void {
  for (const [index, line] of transcript.split('\n').entries()) {
    if (!line.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch (cause) {
      throw new Error(`${path}: line ${index + 1} (type unknown): invalid JSON`, { cause })
    }
    const result = runEventSchema.safeParse(event)
    if (!result.success) {
      const type = event && typeof event === 'object' && 'type' in event ? String(event.type) : 'unknown'
      throw new Error(`${path}: line ${index + 1} (type ${type}): ${result.error.message}`, { cause: result.error })
    }
  }
  writeFileSync(path, transcript, 'utf8')
}
