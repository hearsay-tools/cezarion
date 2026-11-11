import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import type { WorkflowDef } from './types.ts';
import { crashAfterContinue, TINY_PDF, TINY_PDF_B64, TINY_PNG_B64, usePastedAttachmentsFixture } from './pasted-attachments.testkit.ts';

// Continue's pasted attachments: a closed run's composer, a failed disk write and a restart before
// the continuation spawns. Shared setup in pasted-attachments.testkit.ts.

/**
 * End-to-end through the real engine with CEZ_DRY_RUN=1 (open-mercato/cezar#357): a pasted
 * screenshot must land as a real file under `.ai/cezar/runs/<id>-images/`
 * (named `pasted-<n>.<ext>`, never `screenshot-<n>.<ext>` — that prefix stays
 * reserved for the agent's own tool screenshots) and its absolute path must
 * reach the agent in the prompt/message text — verified via the mock's
 * CEZ_MOCK_STDIN_FILE hook, which captures the untruncated inbound text.
 */
describe('pasted screenshots materialize to disk and reach the agent as file paths', () => {
  const fx = usePastedAttachmentsFixture();
  const { readStdinLines, waitForStatus } = fx;

  /** Continue takes a prompt of its own, and the composer that writes it is a full composer —
   *  so a screenshot pasted into a CLOSED run's composer has to travel the same road as one
   *  pasted mid-session: onto disk, into the thread's bubble, and into the reopened session's
   *  opening message as both an inline image and an absolute path. */
  it('a Continue pasted image is saved, rendered on the bubble, and reaches the reopened session', async () => {
    writeFileSync(fx.stdinFile, '', 'utf8');
    const workflow: WorkflowDef = {
      name: 'pasted-continue-test',
      source: 'built-in',
      steps: [{ id: 'work', prompt: '{{task}}' }],
    };
    const record = fx.manager.startRun(workflow, { task: 'do a thing' });
    await waitForStatus(record.id, ['waiting']);
    fx.manager.finish(record.id);
    await waitForStatus(record.id, ['done', 'review']);

    writeFileSync(fx.stdinFile, '', 'utf8');
    const image: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
    };
    expect(fx.manager.continueRun(record.id, { text: 'fix what this shows', images: [image] })).toEqual({
      ok: true,
    });
    await waitForStatus(record.id, ['waiting']);

    const reopened = readStdinLines().find((line) => line.userText.includes('fix what this shows'));
    expect(reopened).toBeDefined();
    // Inline, so the model can view it…
    expect(reopened?.imageCount).toBe(1);
    // …and on disk, so it can operate on it.
    const pathMatch = reopened?.userText.match(/- (.*pasted-\d+\.png)/);
    expect(pathMatch).toBeTruthy();
    const filePath = pathMatch?.[1] as string;
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(Buffer.from(TINY_PNG_B64, 'base64'))).toBe(true);

    // The thread renders the bubble's image, not a bare count — and the base64 stays out of
    // the event log, exactly as on the task-start and follow-up paths.
    const ndjson = readFileSync(join(fx.dataDir, 'runs', `${record.id}.ndjson`), 'utf8');
    const userMessage = ndjson
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string; images?: string[] })
      .find((event) => event.type === 'user-message' && event.text === 'fix what this shows');
    expect(userMessage?.images?.[0]).toBe(`/api/v1/runs/${record.id}/images/${filePath.split('/').pop()}`);
    expect(ndjson).not.toContain(TINY_PNG_B64);

    fx.manager.finish(record.id);
  }, 40_000);

  it('keeps a fresh Continue image viewable when its disk write fails', async () => {
    writeFileSync(fx.stdinFile, '');
    const record = fx.store.createRun({ title: 'image failure', workflow: 'image failure', task: 'original', steps: [] });
    fx.store.addStep(record.id, { id: 'work', name: 'work', kind: STEP_KIND.agent });
    fx.store.updateStep(record.id, 'work', { status: STEP_STATUS.done, sessionId: 'previous-session', backend: 'claude' });
    setRunStatus(fx.store, record.id, RUN_STATUS.done, { worktree: false });
    writeFileSync(join(fx.dataDir, 'runs', `${record.id}-images`), 'not a directory');
    expect(fx.manager.continueRun(record.id, {
      text: 'view this unsaved image',
      images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } }],
    }).ok).toBe(true);
    await waitForStatus(record.id, ['waiting']);
    expect(readStdinLines().find((line) => line.userText.includes('view this unsaved image'))?.imageCount).toBe(1);
    fx.manager.finish(record.id);
    await waitForStatus(record.id, ['done', 'review']);
  }, 30_000);

  it.each(['immediate', 'capacity', 'running', 'missing'] as const)(
    'recovers fresh mixed Continue attachments after a %s pre-spawn restart', async (mode) => {
      writeFileSync(fx.stdinFile, '');
      const record = fx.store.createRun({ title: 'restart', workflow: 'restart', task: 'original', steps: [] });
      fx.store.addStep(record.id, { id: 'work', name: 'work', kind: STEP_KIND.agent });
      fx.store.updateStep(record.id, 'work', { status: STEP_STATUS.done, sessionId: 'previous-session', backend: 'claude' });
      setRunStatus(fx.store, record.id, RUN_STATUS.done, { worktree: false });
      await drainFixtureManagers(fx.repoRoot);
      fx.store.close();
      await crashAfterContinue(fx.repoRoot, fx.dataDir, record.id, mode, [
        { type: 'file', mediaType: 'application/pdf', data: TINY_PDF_B64 },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } },
      ]);
      fx.store = RunStore.open(fx.dataDir, { keepLive: true });
      expect(fx.store.getRun(record.id)?.status).toBe(mode === 'capacity' ? 'queued' : 'running');
      expect(fx.store.getRun(record.id)?.continuationMessage?.text).toBe('read my durable continuation brief');
      expect(readStdinLines().some(line => line.userText.includes('read my durable continuation brief'))).toBe(false);
      const directory = join(fx.dataDir, 'runs', `${record.id}-images`);
      expect(readdirSync(directory).sort()).toEqual(['pasted-1.pdf', 'pasted-2.png']);
      if (mode === 'missing') rmSync(join(directory, 'pasted-1.pdf'));
      if (mode === 'running') {
        fx.store.updateStep(record.id, 'continue-1', { status: STEP_STATUS.running, sessionId: 'new-session', backend: 'claude' });
        fx.store.close();
        fx.store = RunStore.open(fx.dataDir, { keepLive: true });
      }
      fx.manager = createFixtureManager(fx.store, fx.repoRoot);
      await fx.manager.recover();
      await waitForStatus(record.id, ['waiting']);
      const opening = readStdinLines().find((line) => line.userText.includes('read my durable continuation brief'));
      expect(opening).toBeDefined();
      expect(opening?.imageCount).toBe(1);
      expect(opening?.userText).toContain(join(directory, 'pasted-2.png'));
      if (mode === 'missing') {
        expect(opening?.userText).not.toContain(join(directory, 'pasted-1.pdf'));
        expect(fx.store.readEvents(record.id).some((event) => event.type === 'note' && String(event.message).includes('pasted-1.pdf could not be read'))).toBe(true);
      } else {
        expect(opening?.userText).toContain(join(directory, 'pasted-1.pdf'));
        expect(readFileSync(join(directory, 'pasted-1.pdf'), 'utf8')).toBe(TINY_PDF);
      }
      expect(readdirSync(directory).filter((name) => name.startsWith('pasted-')).sort()).toEqual(
        mode === 'missing' ? ['pasted-2.png'] : ['pasted-1.pdf', 'pasted-2.png'],
      );
      expect(opening?.userText).not.toContain(TINY_PDF_B64);
      expect(fx.store.getRun(record.id)?.continuationMessage).toBeUndefined();
      expect(RunStore.open(fx.dataDir, { keepLive: true }).getRun(record.id)?.continuationMessage).toBeUndefined();
      fx.manager.finish(record.id);
      await waitForStatus(record.id, ['done', 'review']);
    }, 30_000,
  );

});
