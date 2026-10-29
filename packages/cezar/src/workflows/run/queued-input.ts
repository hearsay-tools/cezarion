import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isImageAttachmentName } from '@open-mercato/cezar-contract/attachments';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { QueuedMessage, RunRecord } from '../../runs/store.ts';
import { extractTaskRefs, refineTaskRefs } from '../../runs/task-refs.ts';
import { makeRunTitle } from '../../runs/run-title.ts';
import { resolveAttachmentPath } from '../attachment-path.ts';
import { mediaTypeFor, type PastedContent, type PersistedAttachment } from '../pasted-content.ts';
import { stepKind, type WorkflowDef } from '../types.ts';
import type { PendingContinuation, RunModuleContext, StartRunInput } from './types.ts';

interface PersistedAttachments { blocks: ContentBlock[]; attachments: PersistedAttachment[] }
interface QueuedInputHost {
  hasJob(runId: string): boolean; hasContinuation(runId: string): boolean;
  job(runId: string): { workflow: WorkflowDef } | undefined;
  canProceedWithRun(runId: string, run: RunRecord | undefined): run is RunRecord;
  activeGet(runId: string): import('../active-run.ts').ActiveRun | undefined;
  startingHas(runId: string): boolean;
  persistPastedAttachments(runId: string, content: readonly PastedContent[]): PersistedAttachment[];
  toQueuedMessage(runId: string, content: PastedContent[]): QueuedMessage;
  sendMessage(runId: string, content: PastedContent[], messageId?: string): boolean;
}

function foldQueuedTask(task: string, stack: QueuedMessage[]): string {
  return [task, ...stack.map(message => message.text)]
    .map(part => part.trim()).filter(part => part.length > 0).join('\n\n');
}

function queuedContinuationPrompt(openingPrompt: string, amendedTask: string): string {
  return amendedTask ? `${openingPrompt}\n\nCurrent task and queued updates:\n\n${amendedTask}` : openingPrompt;
}

function buildQueuedMessage(content: PastedContent[], images: string[], id: string, createdAt: string): QueuedMessage {
  const text = content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text).join('\n');
  return {
    id,
    text: text.trim() || images.length || !content.some(block => block.type !== 'text')
      ? text : 'The user attached a file, but it could not be saved. Ask them to attach it again before discussing its contents.',
    ...(images.length ? { images } : {}), createdAt,
  };
}

function buildEditedQueuedMessage(current: QueuedMessage, msgId: string, text: string | undefined, uploaded: QueuedMessage | undefined): QueuedMessage {
  const replacementImages = uploaded ? uploaded.images : current.images;
  const replacementText = text ?? current.text;
  return {
    id: msgId,
    text: replacementText.trim() ? replacementText : uploaded?.text || replacementText,
    ...(replacementImages?.length ? { images: replacementImages } : {}),
    createdAt: current.createdAt,
  };
}

export class QueuedInput {
  /** Messages after hydration in the dequeue → session-open gap (#472).
   * Wait-withdrawing entries also retain a durable queue ID until delivered. */
  readonly deferredMessages = new Map<string, Array<{ content: PastedContent[]; messageId?: string }>>();
  constructor(private readonly context: RunModuleContext, private readonly host: QueuedInputHost) {}

  /**
   * Fold the persisted task and queued message stack immediately before execution. Keep durable
   * record state authoritative over pendingJobs. Read-only: never write the composite back to
   * RunRecord.task; task and stack stay separate.
   */
  hydrateQueuedInput(runId: string, input: StartRunInput): StartRunInput {
    const run = this.context.store.getRun(runId);
    if (!run) return input;
    const stack = run.queuedMessages ?? [];

    const task = foldQueuedTask(run.task, stack);

    // Keep the original in-memory blocks for a live process (including the
    // best-effort case where persistence failed). Recovery has no such copy,
    // so rebuild it from the durable task-image URLs.
    const images = input.images?.length
      ? input.images
      : this.readPersistedAttachments(runId, run.taskImages ?? [], 'task').blocks;
    const stackedImages = this.readPersistedAttachments(
      runId,
      stack.flatMap((m) => m.images ?? []),
      'queued',
    ).blocks;

    return {
      ...input,
      task,
      ...(images.length ? { images } : { images: undefined }),
      ...(stackedImages.length ? { stackedImages } : { stackedImages: undefined }),
    };
  }

  /** Apply edits and messages made while a restart continuation waits for
   * capacity. The durable record remains the source of truth, just as it is for
   * an ordinary queued workflow (#472), so a second restart reconstructs and
   * hydrates the same amendments instead of dropping them. */
  hydrateQueuedContinuation(
    runId: string,
    continuation: PendingContinuation,
  ): PendingContinuation & {
    persistedImages: ContentBlock[];
    persistedAttachments: PersistedAttachment[];
  } {
    const run = this.context.store.getRun(runId);
    if (!run) {
      return { ...continuation, persistedImages: [], persistedAttachments: [] };
    }
    const stack = run.queuedMessages ?? [];
    const amendedTask = foldQueuedTask(run.task, stack);
    const openingPrompt = run.continuationMessage?.text ?? continuation.prompt;
    const prompt = queuedContinuationPrompt(openingPrompt, amendedTask);
    const persisted = this.readPersistedAttachments(
      runId,
      stack.flatMap((message) => message.images ?? []),
      'queued',
    );
    return {
      ...continuation,
      prompt,
      persistedImages: persisted.blocks,
      persistedAttachments: persisted.attachments,
    };
  }

  /**
   * Re-read persisted attachments at dequeue/restart (#472): an image comes back as a viewable
   * block AND a path, a file (#950) as a path only. The branch is on the NAME's extension, never
   * on which list the URL came from — images and files share one list, and re-encoding a `.pdf`
   * into a base64 image block is a message no backend can accept.
   *
   * A file is still `stat`-checked here rather than trusted: an attachment the user deleted must
   * drop out of the paths handed to the agent, exactly as a missing image does.
   */
  readPersistedAttachments(
    runId: string,
    urls: string[],
    kind: 'task' | 'queued' | 'continuation',
  ): PersistedAttachments {
    const blocks: ContentBlock[] = [];
    const attachments: PersistedAttachment[] = [];
    for (const url of urls) {
      const name = url.split('/').pop();
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      const path = resolveAttachmentPath(this.context.dataDir, runId, name);
      try {
        if (!path) throw new Error('missing or unsafe attachment');
        if (isImageAttachmentName(name)) {
          const data = readFileSync(path);
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaTypeFor(name), data: data.toString('base64') },
          });
        } else if (!existsSync(path)) {
          throw new Error('missing');
        }
        attachments.push({ name, url, path });
      } catch {
        // Degrade, never fail the boot (AGENTS.md): the user deleted `.ai/cezar/`
        // or the file is unreadable — start with the text and say which attachment went.
        this.context.store.appendEvent(runId, {
          type: 'note',
          message: `${kind} attachment ${name} could not be read — starting without it`,
        });
      }
    }
    return { blocks, attachments };
  }

  /**
   * Still waiting for a slot? Checked against the engine's own queue rather than
   * the record's `status` (#472): the record is written by `execute()` a tick
   * after `pump()` dequeues, so a status read can see `queued` for a run that has
   * already started. The pending maps are deleted synchronously at dequeue, so
   * they are the authoritative answer for "can this prompt still be amended".
   */
  private isQueued(runId: string): boolean {
    return this.host.hasJob(runId) || this.host.hasContinuation(runId);
  }

  /** Split a pasted message into the persisted shape a stacked message holds. */
  toQueuedMessage(runId: string, content: PastedContent[]): QueuedMessage {
    const images = this.host.persistPastedAttachments(runId, content).map((saved) => saved.url);
    return buildQueuedMessage(content, images, randomUUID(), new Date().toISOString());
  }

  /**
   * Append a prompt message onto a still-queued run (#472). Returns the stored
   * entry, or null when the run has already started — the caller then falls
   * through to `deferMessage`.
   */
  enqueueMessage(runId: string, content: PastedContent[]): QueuedMessage | null {
    if (!this.isQueued(runId)) return null;
    const run = this.context.store.getRun(runId);
    if (!this.host.canProceedWithRun(runId, run)) return null;
    const message = this.host.toQueuedMessage(runId, content);
    // Human input cancels no wait in the list (hearsay-tools/cezarion#1233, #1235): beside a wait
    // the message is accepted durably and opens the wake's continuation.
    if (run.waits?.length) this.context.store.commitHumanMessageBesideWaits(runId, message);
    else this.context.store.updateRun(runId, { queuedMessages: [...(run.queuedMessages ?? []), message] });
    return message;
  }

  /** Edit a stacked message in place. Omitted fields retain their current value. */
  editQueuedMessage(
    runId: string,
    msgId: string,
    edit: { text?: string; images?: PastedContent[] },
  ): QueuedMessage | null {
    if (!this.isQueued(runId)) return null;
    const run = this.context.store.getRun(runId);
    const stack = run?.queuedMessages;
    if (!stack) return null;
    const at = stack.findIndex((m) => m.id === msgId);
    if (at < 0) return null;
    const current = stack[at]!;
    const uploaded = edit.images === undefined ? undefined : this.host.toQueuedMessage(runId, edit.images);
    const replacement = buildEditedQueuedMessage(current, msgId, edit.text, uploaded);
    const next = [...stack];
    next[at] = replacement;
    this.context.store.updateRun(runId, { queuedMessages: next });
    // Images the edit dropped are now orphans.
    this.dropOrphanImages(runId, stack[at]!.images ?? [], next);
    return replacement;
  }

  /** Remove a stacked message and its now-orphaned attachments. */
  removeQueuedMessage(runId: string, msgId: string): boolean {
    if (!this.isQueued(runId)) return false;
    const run = this.context.store.getRun(runId);
    const stack = run?.queuedMessages;
    if (!stack) return false;
    const target = stack.find((m) => m.id === msgId);
    if (!target) return false;
    const next = stack.filter((m) => m.id !== msgId);
    this.context.store.updateRun(runId, { queuedMessages: next });
    this.dropOrphanImages(runId, target.images ?? [], next);
    return true;
  }

  /**
   * Delete image files no longer referenced by anything (#472). Best effort — a
   * leftover file is harmless and goes with the run. Never touches a URL still
   * referenced by another stacked entry or by the initial prompt's `taskImages`.
   */
  private dropOrphanImages(runId: string, candidates: string[], stack: QueuedMessage[]): void {
    if (!candidates.length) return;
    const run = this.context.store.getRun(runId);
    const referenced = new Set([
      ...(run?.taskImages ?? []),
      ...stack.flatMap((m) => m.images ?? []),
    ]);
    for (const url of candidates) {
      if (referenced.has(url)) continue;
      const name = url.split('/').pop();
      // Defend the join against a crafted URL: only a bare file name may be deleted.
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      try {
        rmSync(join(this.context.dataDir, 'runs', `${runId}-images`, name), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Edit the initial prompt of a still-queued run (#472). Re-derives the
   * heuristic title and the PR/issue chips, but never re-runs the LLM namer —
   * it already fired at creation and a second model call per edit is unjustified.
   */
  editTask(runId: string, task: string): boolean {
    if (!this.isQueued(runId)) return false;
    const run = this.context.store.getRun(runId);
    if (!run) return false;
    const workflow = this.host.job(runId)?.workflow;
    const skillHint = workflow?.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    const refs = refineTaskRefs(extractTaskRefs(task), skillHint);
    // Hand-edited titles always win (#389): `user` beats the heuristic, and a
    // `marker` title the agent declared beats it too.
    const keepTitle = run.titleOrigin === 'user' || run.titleOrigin === 'marker';
    this.context.store.updateRun(runId, {
      task,
      ...(keepTitle || !workflow ? {} : { title: makeRunTitle(task, workflow) }),
      ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
      ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
    });
    return true;
  }

  /**
   * Buffer a message that arrived in the gap between dequeue and session-open
   * (#472). `pump()` has already folded the stack and `execute()` is spawning the
   * backend, so there is nothing left to amend and no session to deliver into —
   * without this rung the message would 409, a genuinely dropped message in the
   * feature built to stop dropping them. Flushed as an ordinary follow-up turn
   * the instant the session opens; dropped if the run never starts, which the
   * existing error path already surfaces.
   *
   * The buffer lives on the manager rather than the `ActiveRun` because the
   * `ActiveRun` does not exist yet for part of this window.
   */
  deferMessage(runId: string, content: PastedContent[]): boolean {
    const run = this.context.store.getRun(runId);
    if (!this.host.canProceedWithRun(runId, run)) return false;
    // The window spans two sub-states: `starting` (no `ActiveRun` yet) and the
    // longer stretch where the `ActiveRun` exists but the backend is still being
    // spawned. `execute()` deletes the run from `starting` as soon as it builds
    // the state — seconds before the session opens — so checking `starting`
    // alone would reopen exactly the drop this rung exists to close.
    const state = this.host.activeGet(runId);
    const startingUp = this.host.startingHas(runId) || (state !== undefined && !state.sessionEverOpened && !state.cancelled);
    if (!startingUp) return false;
    // The pending maps were removed only AFTER hydration. This entry therefore
    // needs live delivery, never a second fold into the already-created opening.
    // Beside a wait in the list it is accepted durably, and every wait stays
    // (hearsay-tools/cezarion#1235), so a crash before delivery replays it.
    const message = run.waits?.length ? this.host.toQueuedMessage(runId, content) : undefined;
    if (message) this.context.store.commitHumanMessageBesideWaits(runId, message);
    const pending = this.deferredMessages.get(runId) ?? [];
    pending.push({ content, ...(message ? { messageId: message.id } : {}) });
    this.deferredMessages.set(runId, pending);
    return true;
  }

  /** Deliver anything `deferMessage` buffered, once the session is live. */
  flushDeferred(runId: string): void {
    const pending = this.deferredMessages.get(runId);
    if (!pending?.length) return;
    // Re-buffer whatever the session refused rather than dropping it. `sendMessage`
    // answers false when the session is not open yet — and silently losing a message
    // here would be precisely the failure `deferMessage` exists to prevent. Anything
    // left over is retried by the next session that opens on this run.
    const unsent = [];
    for (const entry of pending) {
      const state = this.host.activeGet(runId);
      // A queue entry the delivery's checkpoint left in place stays buffered (`deliverMessage`).
      if (state?.agentInputError || !this.host.sendMessage(runId, entry.content, entry.messageId) ||
        (entry.messageId && this.context.store.getRun(runId)?.queuedMessages?.some(message => message.id === entry.messageId))) unsent.push(entry);
    }
    if (unsent.length) this.deferredMessages.set(runId, unsent);
    else this.deferredMessages.delete(runId);
  }

}
