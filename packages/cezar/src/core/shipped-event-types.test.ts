/**
 * The shipped event `type` strings are additive-only.
 *
 * A run's events are saved as NDJSON, so every `type` string that shipped is in transcripts on
 * users' disks. Removing or renaming one makes those transcripts unreadable: it is a breaking
 * change (`BACKWARD_COMPATIBILITY.md`). `tsc` holds the rule here, as it does in
 * `ui-events.test.ts`; the typecheck runs over test files.
 *
 * v2 `UiEvent` types are pinned in `ui-events.test.ts`: the keys of its `renderRelevance` map are
 * the exact `UiEventType` set. This file pins v1.
 */
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';

/**
 * Every v1 `AgentEvent` `type` string that shipped. Append a new variant; never remove or rename
 * an entry. `satisfies` fails when `AgentEvent` loses one of these strings.
 */
const SHIPPED_V1_TYPES = [
  'text',
  'tool-call',
  'tool-result',
  'image',
  'token-usage',
  'cost',
  'session',
  'turn-end',
  'input-unconsumed',
  'note',
  'done',
  'error',
] as const satisfies ReadonlyArray<AgentEvent['type']>;

/** `true` only while the list above names every `AgentEvent` variant. */
type ListsEveryVariant = [Exclude<AgentEvent['type'], (typeof SHIPPED_V1_TYPES)[number]>] extends [never] ? true : false;

describe('shipped v1 AgentEvent type strings', () => {
  it('lists every variant, each once', () => {
    // Fails to compile when `AgentEvent` gains a variant that `SHIPPED_V1_TYPES` does not list.
    const listsEveryVariant: ListsEveryVariant = true;
    expect(listsEveryVariant).toBe(true);
    expect(new Set(SHIPPED_V1_TYPES).size).toBe(SHIPPED_V1_TYPES.length);
  });
});
