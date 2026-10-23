import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeSidebarLimits, type UiState } from '@open-mercato/cezar-contract/workspace';

/**
 * `.ai/cezar/ui-state.json` — small GUI preferences the cockpit persists (files, not a DB).
 * The server owns the schema and the writes (`PUT /api/ui-state` in `src/server/server.ts`);
 * this is the shared read path, so the CLI can honour a preference the cockpit set (for example
 * `disabledTeamSkills`) without a second notion of where the file lives.
 *
 * Same zero-config rule as `src/config.ts`: missing, unreadable or malformed all degrade to
 * `{}` — an absent preference, never a throw, never a blocked startup.
 */
export function uiStatePath(repoRoot: string): string {
  return join(repoRoot, '.ai/cezar', 'ui-state.json');
}

/**
 * Read `ui-state.json` on demand — never cached, never throws. Only the project's own file is
 * read: no workspace-level key is merged in.
 *
 * Typed by the CONTRACT (`UiState`), not by a loose record: `GET /api/v1/ui-state` answers this
 * value verbatim, so a `Record<string, unknown>` here made the route name no key at all and the
 * per-route parity guard vacuous — the same defect `healthSnapshot` had. `UiState` is a
 * `z.looseObject`, so the index signature (and with it the round-trip promise of
 * BACKWARD_COMPATIBILITY.md §3) survives; what it adds is the NAMES of the keys the server knows.
 *
 * Only sidebarLimits is normalized field by field through its contract schema. Unrelated
 * preferences retain their existing open-bag behavior. The file is user-editable JSON and is
 * deliberately NOT parsed through the whole schema, because a single malformed pref must not discard the whole bag (§3). What
 * the type asserts is the wire shape the route promises; the write side (`PUT /ui-state`, validated
 * by `uiStateBody`) is what actually enforces it.
 */
export async function readUiState(repoRoot: string): Promise<UiState> {
  return readProjectUiState(repoRoot);
}

/** The project's own file. Writes merge from this. */
export async function readProjectUiState(repoRoot: string): Promise<UiState> {
  try {
    return parseUiState(await readFile(uiStatePath(repoRoot), 'utf8'));
  } catch {
    return {}; // Missing or unreadable: an empty preference bag.
  }
}

/**
 * `readProjectUiState` for a synchronous caller: a live message is expanded inside
 * `sendMessage`, which answers synchronously, and must see the off-list as it is now (#1494).
 */
export function readProjectUiStateSync(repoRoot: string): UiState {
  try {
    return parseUiState(readFileSync(uiStatePath(repoRoot), 'utf8'));
  } catch {
    return {};
  }
}

function parseUiState(text: string): UiState {
  let state: UiState = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      state = parsed as UiState;
      if ('sidebarLimits' in state) state = { ...state, sidebarLimits: normalizeSidebarLimits(state.sidebarLimits) };
    }
  } catch {
    // Malformed: an empty preference bag.
  }
  return state;
}
