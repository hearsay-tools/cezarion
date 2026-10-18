/**
 * What the composer may attach, and how an attachment is named on disk.
 *
 * No runtime import, so a consumer of these loads no schema (hearsay-tools/cezarion#1237).
 */

/**
 * Non-image attachment types the composer may send (#950). Deliberately an allowlist and
 * deliberately short: cezar serves these files back from the cockpit's own origin, so every entry
 * here is one more thing that must be safe to hand a browser. `image/*` stays a regex — narrowing
 * what the route has always accepted would be the breaking half of this change.
 *
 * `text/x-markdown` is the spelling some browsers still report for a `.md`.
 */
export const FILE_ATTACHMENT_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/pdf',
] as const;

/** Does this media type travel as an inline image block the model can look at? */
export function isImageMediaType(mediaType: string): boolean {
  return /^image\//.test(mediaType);
}

/** Is this something the composer may attach at all — an image, or one of the file types above? */
export function isAttachmentMediaType(mediaType: string): boolean {
  return (
    isImageMediaType(mediaType) ||
    (FILE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(mediaType)
  );
}

/**
 * The on-disk extension for an attachment, derived from its media type ALONE — the user's own
 * filename never reaches the wire, and therefore never reaches a path. `img` is the pre-existing
 * catch-all for an image type cezar does not name (an SVG, a BMP), kept so those files land where
 * they always did.
 */
export function attachmentExtension(mediaType: string): string {
  return /png/.test(mediaType) ? 'png'
    : /jpe?g/.test(mediaType) ? 'jpg'
    : /webp/.test(mediaType) ? 'webp'
    : /gif/.test(mediaType) ? 'gif'
    : mediaType === 'application/pdf' ? 'pdf'
    : mediaType === 'text/plain' ? 'txt'
    : mediaType === 'text/markdown' || mediaType === 'text/x-markdown' ? 'md'
    : 'img';
}

/** Extensions `attachmentExtension` produces for an inline image. */
const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'img']);

/**
 * Does a persisted attachment name (`pasted-3.pdf`, `screenshot-1.png`) refer to an image?
 *
 * The one predicate every reader branches on — the engine deciding whether to re-encode a file as
 * an image block, and the cockpit deciding between a thumbnail and a named chip. Branch on the
 * NAME, never on the list an entry came from: images and files share one list and one numbering
 * space on disk, and that is what keeps the orphan sweep, the restart re-read and the per-stack
 * cap on a single code path.
 */
export function isImageAttachmentName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext !== undefined && IMAGE_ATTACHMENT_EXTENSIONS.has(ext);
}
