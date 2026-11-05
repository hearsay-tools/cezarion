import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@open-mercato/cezar-contract';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { iso, NOW } from './activity.testkit.ts';
import { buildActivityProject } from './read-model.ts';

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

/** One snapshot decodes each cold record once (hearsay-tools/cezarion#2378): the ledger read, the
 *  reconcile lookups and the request titles all name the same runs. */
describe('an activity snapshot decodes each cold run once', () => {
  let dataDir: string;
  let store: RunStore;
  const sender = randomUUID();
  const recipient = randomUUID();

  beforeEach(() => {
    dataDir = join(mkdtempSync(join(tmpdir(), 'cez-activity-decodes-')), '.ai/cezar');
    const request: ConversationMessage = { id: randomUUID(), senderRunId: sender, recipientRunId: recipient, kind: 'request', relationship: 'peer',
      text: 'Which branch?', createdAt: iso(-5_000), requestHash: 'a'.repeat(64), state: 'accepted' };
    const root = (id: string, messages: ConversationMessage[]) => makeRunRecord({ id, status: RUN_STATUS.done,
      delegation: { role: 'root', permissions: [], receipts: [], conversation: { messages, outcomes: [] } } });
    // Both settled: nothing is held, so every read is a cold row.
    seedRuns(dataDir, [root(sender, [request]), root(recipient, [])]);
    store = RunStore.open(dataDir);
    decodes.clear();
  });
  afterEach(() => {
    store.close();
    rmSync(join(dataDir, '../..'), { recursive: true, force: true });
  });

  it('reads the sender’s ledger, both lookups and both titles from one decode each', () => {
    // Neither lifecycle has settled in this process, so the request stays open and is drawn.
    const { project } = buildActivityProject({ projectId: 'shop', name: 'Shop', loaded: { store, isActive: () => true } }, {}, { now: NOW, carryOver: [sender] });
    expect(project.requests.map((entry) => [entry.senderRunId, entry.recipientRunId, entry.senderTitle !== undefined, entry.recipientTitle !== undefined]))
      .toEqual([[sender, recipient, true, true]]);
    expect([decodes.get(sender), decodes.get(recipient)]).toEqual([1, 1]);
  });
});
