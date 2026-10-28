import type { ConversationMessage } from '@open-mercato/cezar-contract/conversations';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import { resolveAttachmentPath } from '../attachment-path.ts';
import { contentBlocksOf, type PastedContent, type PersistedAttachment } from '../pasted-content.ts';
import { stepKind } from '../types.ts';
import { agentInputOutcomeText } from './input-batch.ts';
import type { ContinuationOpening, Execution } from './types.ts';

export interface OpeningHost {
  routedAsk(runId: string): { askSeq: number; message: ConversationMessage } | undefined;
  readPersistedAttachments(runId: string, urls: string[], kind: 'task' | 'queued' | 'continuation'): { blocks: ContentBlock[]; attachments: PersistedAttachment[] };
}

/** A Continue's opening message: the checkpoint's agent input with its outcome, its images and
 *  attachments, and the `user-message` event that shows it. */
export function continuationOpening(
  store: RunStore,
  host: OpeningHost,
  runId: string,
  stepId: string,
  state: ActiveRun,
  record: RunRecord | undefined,
  input: { prompt: string; images: PastedContent[]; persistedImages: ContentBlock[]; persistedAttachments: PersistedAttachment[] },
): ContinuationOpening {
  const checkpoint = record?.continuationMessage;
  state.openingAgentInputId = checkpoint?.agentInputId;
  const openingInput = record?.agentInputs?.find(input => input.id === checkpoint?.agentInputId);
  // Hydration has already included later human updates and task edits. Append
  // the current obligation outcome without replacing that composed prompt.
  // A parent's answer to a routed question (#505) is shown as its conversation reply, not
  // as a human message, and its own reply outcome is not news to the worker.
  const parentAnswer = openingInput?.conversation?.kind === 'reply' && host.routedAsk(runId) !== undefined;
  let prompt = input.prompt;
  if (openingInput && !parentAnswer) prompt += agentInputOutcomeText(openingInput, store.getRun(openingInput.parentRunId));
  const { openingImages, attachments } = continuationImages(host, runId, stepId, checkpoint, input);
  if (checkpoint?.origin !== 'lifecycle' && !parentAnswer) store.appendEvent(runId, {
    type: 'user-message',
    stepId,
    text: prompt,
    imageCount: openingImages.filter((b) => b.type === 'image').length,
    ...(attachments.length ? { images: attachments.map((saved) => saved.url) } : {}),
  });
  return { prompt, checkpoint, parentAnswer, openingImages, attachments };
}

/** A Continue's opening images and attachments. */
export function continuationImages(
  host: OpeningHost,
  runId: string,
  stepId: string,
  checkpoint: RunRecord['continuationMessage'],
  input: { images: PastedContent[]; persistedImages: ContentBlock[]; persistedAttachments: PersistedAttachment[] },
): { openingImages: ContentBlock[]; attachments: PersistedAttachment[] } {
  // Attachments pasted into the follow-up composer, on the same terms as a live-session
  // message (#357): persisted to the run's own attachment store so the thread renders the
  // bubble's images rather than a bare count, and handed to the agent as absolute paths
  // appended to the prompt (so it can operate on them — and because codex/opencode drop image
  // blocks before they reach the model). An image ALSO rides along as a base64 block so the
  // model can view it; a file (#950) has nothing to view and travels as its path alone.
  const saved = host.readPersistedAttachments(
    runId, checkpoint?.id === stepId ? checkpoint.images ?? [] : [], 'continuation',
  );
  const openingImages = [...(input.images.length ? contentBlocksOf(input.images) : saved.blocks), ...input.persistedImages];
  const attachments = [...saved.attachments, ...input.persistedAttachments];
  return { openingImages, attachments };
}

/**
 * The task's attachments for the first agent step's opening message, and its image blocks.
 * Both are empty once an agent step of this workflow has run.
 */
export function openingInputs(store: RunStore, dataDir: string, execution: Execution): { attachments: PersistedAttachment[]; images: ContentBlock[] | undefined } {
  const { runId, workflow, input } = execution;
  // `startRun` already persisted the task's attachments so a queued bubble can render them
  // (#612). Reuse those files for the agent-facing path note instead of minting
  // duplicate pasted files when execution finally begins.
  //
  // The STACK's attachments (#472) are listed here too: they were persisted when they were
  // enqueued, and their paths are the only thing an agent ever gets for a non-image one — a
  // note that covered the initial prompt alone would hand it a task about a file it was never
  // told the path of (#950).
  const startRecord = store.getRun(runId);
  const openingAlreadyDelivered = workflow.steps.some(definition =>
    stepKind(definition) === 'agent' &&
    (startRecord?.steps.find(step => step.id === definition.id)?.iterations ?? 0) > 0,
  );
  const attachments: PersistedAttachment[] = openingAlreadyDelivered ? [] : [
    ...(startRecord?.taskImages ?? []),
    ...(startRecord?.queuedMessages ?? []).flatMap((m) => m.images ?? []),
  ]
    .map((url): PersistedAttachment | null => {
      const name = url.split('/').pop();
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
      const path = resolveAttachmentPath(dataDir, runId, name);
      if (!path) {
        store.appendEvent(runId, {
          type: 'note',
          message: `task attachment ${name} could not be read — starting without it`,
        });
        return null;
      }
      return { name, url, path };
    })
    .filter((saved): saved is PersistedAttachment => saved !== null);
  // Task screenshots go with the FIRST agent step's opening message only —
  // later steps and retry loops run in fresh sessions without them. Stacked
  // attachments (#472) ride along too, but are NOT re-persisted above: they
  // already live on disk, and adding them to `taskImages` would both duplicate
  // the files and make the task bubble claim the stack's images as its own.
  // File blocks are dropped here — a session only ever sees viewable blocks (#950). An empty
  // result stays `undefined` rather than `[]`, so a task carrying only files hands the runner
  // seam exactly the shape a task carrying nothing always did.
  const blocks = openingAlreadyDelivered
    ? []
    : contentBlocksOf([...(input.images ?? []), ...(input.stackedImages ?? [])]);
  return { attachments, images: blocks.length ? blocks : undefined };
}
