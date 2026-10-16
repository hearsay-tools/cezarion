/**
 * Shared rules for native hook runs (#961), used by every mapper whose wire
 * reports hooks (claude `hook_response`, codex `hook/completed`).
 * Spec: `docs/superpowers/specs/2026-10-15-hook-transcript-entries-design.md`.
 */
import type { UiHookItem } from './ui-events.ts';

/** Native event name, PascalCase: codex sends `sessionStart`, claude `SessionStart`. */
export function hookEventName(native: string): string {
  return native.charAt(0).toUpperCase() + native.slice(1);
}

/**
 * A hook run earns a transcript entry only when it told the agent something or
 * did not simply succeed. Raw stdout alone never counts: control JSON such as
 * `{"continue":true}` on every PreToolUse would put a card on every tool call.
 */
export function isVisibleHookItem(item: UiHookItem): boolean {
  return item.status !== 'completed' || item.entries.length > 0;
}
