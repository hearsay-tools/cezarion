import { readdirSync } from 'node:fs';
import { isImageMediaType } from '@open-mercato/cezar-contract/attachments';
import type { ContentBlock } from '../core/agent-runner.ts';

/** Pasted attachments: how a user's images and files reach the engine and the agent. Moved out of
 *  `run.ts` unchanged; `run.ts` re-exports every name. */

/**
 * Materialized pasted attachment: the on-disk name/serving-URL pair the
 * transcript already used, plus the absolute path that lets the agent
 * operate on the file itself — save it, `cp` it, attach it to a GitHub
 * issue/PR (#357). `path` is only ever an absolute path under
 * `.ai/cezar/runs/<runId>-images/` (see `RunManager.persistAttachment`).
 */
/** Inverse of `attachmentExtension` (#472) — a persisted attachment is re-encoded from disk at
 *  dequeue and needs its media type back. Only ever asked about IMAGE names (a file reaches the
 *  agent as a path, never as a block), so an unknown extension still answers `image/png`: that is
 *  the pre-existing fallback for the `.img` an SVG or a BMP paste lands as. */
export function mediaTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'jpg' ? 'image/jpeg'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/png';
}

/** Highest `<prefix>-<n>.<ext>` suffix already present in a run's image dir (#472).
 *  `screenshot-*` and `pasted-*` share one numbering space, so this scans both and
 *  returns 0 for a missing/empty directory. */
export function highestImageSeq(dir: string): number {
  try {
    return readdirSync(dir).reduce((max, name) => {
      const m = /^(?:screenshot|pasted)-(\d+)\./.exec(name);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
  } catch {
    return 0;
  }
}

export interface PersistedAttachment {
  name: string;
  url: string;
  path: string;
}

/**
 * A user attachment that is NOT an image (#950) — a PDF, a `.txt`, a `.md`.
 *
 * Deliberately not a `ContentBlock` variant: `ContentBlock` is the runner protocol
 * (`AGENT_PROTOCOL.md`), and a file has nothing a model can look at. The RunManager
 * converts these into files on disk plus a path in the prompt before anything is
 * handed to a session, so a `file` block can never reach a backend.
 */
export interface FileBlock {
  type: 'file';
  mediaType: string;
  data: string;
}

/** What the routes hand the engine: image/text blocks the session will see, plus file blocks it
 *  will never see. Every RunManager entry point accepts this wider type. */
export type PastedContent = ContentBlock | FileBlock;

/** One wire attachment (`{mediaType, data}`) as the engine wants it: an image the model can view,
 *  or a file it will only ever be given the path of. The single mapping the four attachment-
 *  carrying routes share, so none of them can invent a different one. */
export function toPastedContent(attachment: { mediaType: string; data: string }): PastedContent {
  return isImageMediaType(attachment.mediaType)
    ? { type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data } }
    : { type: 'file', mediaType: attachment.mediaType, data: attachment.data };
}

/** The image blocks of a mixed list — what may be delivered to a session. */
export function contentBlocksOf(content: readonly PastedContent[]): ContentBlock[] {
  return content.filter((b): b is ContentBlock => b.type !== 'file');
}

/**
 * Plain-text note listing the absolute paths of pasted attachments, appended
 * to the message that carries them (#357). The base64 image blocks stay in
 * the message for the model to *view*; this note is what lets it *use* the
 * files as files — and the only usable reference on backends (codex,
 * opencode) whose `textOf()` drops image blocks before reaching the model.
 */
export function pastedAttachmentsText(attachments: PersistedAttachment[]): string {
  const list = attachments.map((a) => `- ${a.path}`).join('\n');
  return (
    `The user attached ${attachments.length} pasted file${attachments.length > 1 ? 's' : ''}, ` +
    `also saved on disk at:\n${list}\n` +
    `When the task involves saving, uploading, attaching, or transforming the pasted content ` +
    `(e.g. attaching to a GitHub issue/PR, copying into the repo), operate on these files — do ` +
    `not attempt to reconstruct them from the conversation.`
  );
}

/** Same note as `pastedAttachmentsText`, wrapped as a trailing `ContentBlock`
 *  ready to append to a message's content array. */
export function pastedAttachmentsNote(attachments: PersistedAttachment[]): ContentBlock {
  return { type: 'text', text: pastedAttachmentsText(attachments) };
}
