import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import {
  controlledWire, manager, root, semaphore, store, terminal, until,
  useWorkerWaitFixture,
} from './worker-wait.testkit.ts';

describe('worker inbox holds nonfinal agent completion', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

  async function startChain() {
    const gate = join(root, 'inbox-chain-gate');
    const wire = controlledWire({ firstResultGate: gate });
    const run = manager.startRun({ name: 'inbox chain', source: 'built-in', steps: [
      { id: 'task', prompt: '{{task}}' }, { id: 'check', command: 'echo checked' },
    ] }, { task: 'Handle worker progress', runner: 'claude' });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    await until(wire.initialReceived);
    const sender = { id: randomUUID() };
    return { run, sender, gate };
  }

  it.each(['release', 'expiry', 'ack'] as const)('keeps the agent→check recipient live until inbox %s', async action => {
    const { run, sender, gate } = await startChain();
    const input = { id: randomUUID(), parentRunId: run.id, source: 'agent' as const,
      text: 'Review this before checking', createdAt: new Date().toISOString(),
      conversation: { senderRunId: sender.id, recipientRunId: run.id, kind: 'progress' as const } };
    store.commitAgentInputs(run.id, [input]);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const generation = randomUUID();
    const receipt = manager.reserveInboxInputs(run.id, generation, [input.id])!;
    expect(receipt).toBeDefined();
    const engine = manager as unknown as { active: Map<string, { session?: AgentSession }> };
    const session = engine.active.get(run.id)!.session!;
    writeFileSync(gate, 'release');
    await until(() => store.readEvents(run.id).some(event => event.type === 'turn-end'));
    await vi.advanceTimersByTimeAsync(400); // Beyond the runner's actual auto-end window.
    expect(session.open).toBe(true);
    expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['running', 'pending']);
    expect(store.getRun(run.id)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();

    if (action === 'expiry') await vi.advanceTimersByTimeAsync(120_000);
    else if (action === 'release') manager.releaseInbox(run.id, generation, receipt.receiptId);
    else manager.acknowledgeInbox(run.id, generation, receipt.receiptId);
    await until(() => terminal.includes(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
    expect(store.getRun(run.id)?.agentInputs?.[0]?.deliveredAt).toBeDefined();
    expect(store.readEvents(run.id).filter(event => event.type === 'turn-end')).toHaveLength(action === 'ack' ? 1 : 2);
    expect(semaphore.busy()).toBe(0);
  });

  it('auto-ends the same chain normally without an inbox claim', async () => {
    const { run, gate } = await startChain();
    writeFileSync(gate, 'release');
    await until(() => terminal.includes(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
    expect(semaphore.busy()).toBe(0);
  });
});
