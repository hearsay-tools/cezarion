import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { manager, root, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { conversationPair, turnEnds } from './worker-wait-conversations.testkit.ts';

describe('parent and worker conversation waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const runner of RUNNER_IDS) {
    it(`${runner} WP2 preserves a resumed request for 45 minutes and delivers its late reply amendment`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      const f = await conversationPair(runner);
      const release = join(root, 'resume-receipt-release');
      try {
        await expect(f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id,
          kind: 'request', text: 'Still active', resume: true, timeoutSeconds: 7201 })).rejects.toMatchObject({ code: 'incompatible_state' });
        manager.finish(f.w.id);
        await until(() => !manager.isActive(f.w.id));
        process.env.CEZ_MOCK_RELEASE_FILE = release;
        const boundaries = turnEnds(f.w.id);
        const started = Date.now();
        const sent = await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id,
          kind: 'request', text: 'Fix review mock:hold-gated', resume: true, timeoutSeconds: 3600 });
        await until(() => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === sent.message.id)?.deliveredAt);
        // hearsay-tools/cezarion#2173: acceptance must reach both transcripts before another
        // message, history read or turn end can incidentally reconcile the saved receipt.
        const accepted = store.getRun(f.w.id)!.agentInputs!.find(input => input.id === sent.message.id)!;
        for (const id of [f.p.id, f.w.id]) {
          expect(store.readEvents(id).filter(event => event.type === 'conversation-message' &&
            (event.message as { id: string }).id === sent.message.id && event.delivery === 'delivered'))
            .toEqual([expect.objectContaining({ deliveredAt: accepted.deliveredAt })]);
        }
        expect(turnEnds(f.w.id)).toBe(boundaries);
        expect(accepted.consumedAt).toBeUndefined();
        expect(store.getRun(f.w.id)?.continuationMessage?.agentInputId).toBe(sent.message.id);
        expect(store.getRun(f.p.id)?.delegation).toMatchObject({ conversation: { outcomes: [] } });
        writeFileSync(release, 'release');
        await until(() => store.getRun(f.w.id)?.status === 'waiting');
        expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === sent.message.id)?.consumedAt).toBeDefined();
        expect(store.getRun(f.w.id)?.continuationMessage).toBeUndefined();
        // Only the wall clock changes: native mock wire/process timers keep running.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(started + 45 * 60_000);
        expect((await f.service.conversation(f.parentCaller, { recipientRunId: f.w.id })).outcomes).toEqual([]);
        vi.setSystemTime(started + 61 * 60_000);
        expect((await f.service.conversation(f.parentCaller, { recipientRunId: f.w.id })).outcomes[0]?.status).toBe('timed-out');
        const reply = await f.service.reply(f.workerCaller, { id: randomUUID(), recipientRunId: f.p.id,
          kind: 'reply', requestId: sent.message.id, text: 'Fixed mock:hold', timeoutSeconds: 600 });
        expect(reply.outcome).toMatchObject({ status: 'replied-late', replyId: reply.message.id });
        await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === reply.message.id)?.deliveredAt);
        expect(store.readEvents(f.p.id).some(event => event.type === 'request-outcome' && requestOutcomeSchema.safeParse(event.outcome).data?.status === 'replied-late')).toBe(true);
      } finally { writeFileSync(release, 'release'); vi.useRealTimers(); f.close(); }
    });
  }

});
