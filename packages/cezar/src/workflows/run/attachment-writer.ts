import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentExtension } from '@open-mercato/cezar-contract/attachments';
import { attachmentDirectory } from '../attachment-path.ts';
import { highestImageSeq, type PastedContent, type PersistedAttachment } from '../pasted-content.ts';
import type { RunModuleContext } from './types.ts';

interface AttachmentWriterHost {
  persistAttachment(runId: string, mediaType: string, data: string, namePrefix?: string): PersistedAttachment | null;
}

export class AttachmentWriter {
  /** Per-run counter independent of ActiveRun, so queued runs can persist attachments.
   * Seeded lazily from disk on the first write. */
  readonly queuedImageSeq = new Map<string, number>();

  constructor(private readonly context: RunModuleContext, private readonly host: AttachmentWriterHost) {}

  /**
   * Persist every attachment a user message carries — images and files alike (open-mercato/cezar#950) — into the
   * run's own attachment folder, in the order they were attached. The returned paths are what the
   * agent is told about; the caller decides which of them also ride along as viewable blocks.
   */
  persistPastedAttachments(
    runId: string,
    content: readonly PastedContent[],
  ): PersistedAttachment[] {
    return content
      .map((b) => {
        const saved = b.type === 'image'
          ? this.host.persistAttachment(runId, b.source.media_type, b.source.data, 'pasted')
          : b.type === 'file'
            ? this.host.persistAttachment(runId, b.mediaType, b.data, 'pasted')
            : null;
        if (b.type === 'file' && !saved) {
          this.context.store.appendEvent(runId, {
            type: 'note', tone: 'danger',
            message: `${b.mediaType} attachment could not be saved — please attach it again`,
          });
        }
        return saved;
      })
      .filter((saved): saved is PersistedAttachment => saved !== null);
  }

  /**
   * Agent screenshot (an image block inside a tool result) or a user attachment —
   * a pasted screenshot, or since open-mercato/cezar#950 a PDF/TXT/MD file: the base64 data never
   * enters the NDJSON event log — it lands as a file under
   * `.ai/cezar/runs/<id>-images/` and the transcript event carries only the name +
   * serving URL. `namePrefix` distinguishes the two origins on disk
   * (`screenshot-<n>.<ext>` for agent tool screenshots, `pasted-<n>.<ext>` for user
   * attachments, open-mercato/cezar#357) and the absolute `path` lets the agent operate on the file
   * directly (save/attach/upload) — for a non-image attachment that path is the ONLY
   * way it ever reaches the agent.
   * Best effort: on failure the attachment is dropped, the transcript still
   * shows the tool result's `[screenshot]` placeholder (or the image count).
   */
  persistAttachment(
    runId: string,
    mediaType: string,
    data: string,
    namePrefix: string = 'screenshot',
  ): PersistedAttachment | null {
    try {
      // One mapping, shared with the wire (`packages/contract`): an image keeps the extension it
      // always had, a file gets `pdf`/`txt`/`md`, and both share the `pasted-<n>` numbering space
      // below so a `pasted-3.md` can never collide with a `pasted-3.png`.
      const ext = attachmentExtension(mediaType);
      const dir = join(this.context.dataDir, 'runs', `${runId}-images`);
      mkdirSync(dir, { recursive: true });
      if (!attachmentDirectory(this.context.dataDir, runId)) return null;
      // Seed from the highest numeric suffix already on disk, NOT the file count:
      // `screenshot-*` and `pasted-*` share one numbering space, so counting would
      // re-issue a live number after any deletion. Only matters on the first write
      // of a process (restart case) — afterwards the map is authoritative.
      let seq = this.queuedImageSeq.get(runId);
      if (seq === undefined) seq = highestImageSeq(dir);
      // `persistAttachment` is fully synchronous, so two pastes cannot interleave between
      // the read of the counter and the write. The exclusive-create flag is the
      // belt-and-braces guard for a stale seed: it degrades to a renamed file rather
      // than a silent overwrite.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        seq += 1;
        const name = `${namePrefix}-${seq}.${ext}`;
        const path = join(dir, name);
        try {
          writeFileSync(path, Buffer.from(data, 'base64'), { flag: 'wx' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw err;
        }
        this.queuedImageSeq.set(runId, seq);
        // Versioned, because that is the only surface served now. The cockpit still upgrades
        // the unversioned URLs sitting in OLD transcripts when it renders them
        // (`resolveApiUrl`), but a URL minted today must be fetchable as written.
        return { name, url: `/api/v1/runs/${runId}/images/${name}`, path };
      }
      return null;
    } catch {
      return null;
    }
  }

}
