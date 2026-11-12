import type { z } from 'zod';

/**
 * Best-effort structured-output extraction (trimmed from @cezar/core's
 * `parseStructured`): try the whole string after stripping a ```json fence,
 * then scan for balanced top-level `{...}` blocks and return the first that
 * validates. Null when nothing does — the caller decides how to recover.
 */
export function parseStructured<T>(raw: string, schema: z.ZodType<T, unknown>): T | null {
  const cleaned = raw
    .replace(/^```(?:json|javascript|js|jsonl)?\s*\n?/im, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch {
    for (const candidate of extractJsonObjectCandidates(raw)) {
      try {
        return schema.parse(JSON.parse(candidate));
      } catch {
        continue;
      }
    }
    return null;
  }
}

export function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}
