import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { seedSettledFamily } from './delegation-reconcile.testkit.ts';

/** Successful `decodeRunRow` calls, by run id: the store calls `collectRawExtras` once per decode. */
const decodes = vi.hoisted(() => new Map<string, number>());
vi.mock('../runs/raw-record.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs/raw-record.ts')>();
  return { ...actual, collectRawExtras: (raw: unknown, parsed: unknown) => {
    const id = (parsed as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string') decodes.set(id, (decodes.get(id) ?? 0) + 1);
    return actual.collectRawExtras(raw, parsed);
  } };
});

/** One family reconcile pass decodes each cold member at most once (hearsay-tools/cezarion#2378). */
describe('family reconcile decodes each cold run once per pass', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let family: ReturnType<typeof seedSettledFamily>;

  beforeEach(() => {
    vi.stubEnv('CEZ_DELEGATION', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-reconcile-decodes-'));
    const seeding = RunStore.open(join(root, '.ai/cezar'));
    family = seedSettledFamily(seeding, root);
    const conversation = seeding.getRun(family.parentId)!.delegation;
    if (conversation?.role !== 'root' || !conversation.conversation) throw new Error('expected a conversation root');
    const messages: ConversationMessage[] = [...conversation.conversation.messages];
    for (let i = 0; i < 60; i++) {
      const [senderRunId, recipientRunId] = i % 2 ? [family.workerId, family.parentId] : [family.parentId, family.workerId];
      messages.push({ id: randomUUID(), senderRunId, recipientRunId, kind: 'progress', text: `progress ${i}`,
        createdAt: new Date(Date.now() + i).toISOString(), requestHash: 'c'.repeat(64), state: 'accepted' });
    }
    seeding.commitConversation(family.parentId, { messages, outcomes: [] });
    seeding.close();
    // Reopened, nothing is held: every member of the settled family is a cold row.
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    decodes.clear();
  });
  afterEach(() => {
    manager.dispose(); store.close(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const memberDecodes = () => [family.parentId, family.workerId].map((id) => decodes.get(id) ?? 0);

  it('a pass that projects the conversation decodes each member at most once', () => {
    manager.reconcileWorkerWaits(family.parentId);
    expect(store.readEvents(family.workerId).filter((event) => event.type === 'conversation-message')).toHaveLength(61);
    expect(Math.max(...memberDecodes())).toBeLessThanOrEqual(1);
  });

  it('a pass with nothing to repair decodes each member at most once', () => {
    manager.reconcileWorkerWaits(family.parentId);
    store.flush(); // the written members leave memory: the next pass reads cold rows again
    decodes.clear();
    manager.reconcileWorkerWaits(family.parentId);
    expect(Math.max(...memberDecodes())).toBeLessThanOrEqual(1);
  });
});
