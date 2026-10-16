import type { UiItem } from '@open-mercato/cezar-api-client'

// Every new protocol item kind must explicitly decide whether it can nest under an agent.
const CHILD_KINDS: Record<UiItem['kind'], boolean> = {
  message: true,
  reasoning: true,
  tool: true,
  hook: true,
}

/** Render-only thread entries are not agent children. Plan tools are filtered by callers. */
export function isSubagentChildKind(kind: string): kind is UiItem['kind'] {
  return Object.hasOwn(CHILD_KINDS, kind) && CHILD_KINDS[kind as UiItem['kind']]
}
