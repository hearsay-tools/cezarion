import { z } from 'zod';
import { attachmentInputSchema } from './runs.ts';
import { runnerSchema } from './health.ts';
const RUNNER_IDS = runnerSchema.options;

// PATCH semantics are load-bearing here: an omitted field keeps its current value.
// In particular, the cockpit edits text without re-uploading existing attachments.
export const queuedMessagePatchSchema = z
  .object({
    text: z.string().max(100_000).optional(),
    images: z.array(attachmentInputSchema).max(4).optional(),
  })
  .refine((m) => m.text !== undefined || m.images !== undefined, {
    message: 'message edit needs text or attachments',
  });

// "Continue"/"Send back" body (spec 003 / legacy reference 401): every field optional, so an empty POST reopens
// the last session on the run's current backend (backward compat). A runner/model/account override
// lets the follow-up composer choose which engine handles the continuation. `text` stays bounded
// like the live-session message `text` (legacy reference 429), and `images` like a live-session message's — the
// follow-up composer is a full composer, so a screenshot pasted into it must reach the reopened
// session rather than being silently dropped.
export const continueSchema = z.object({
  text: z.string().max(100_000, 'must be at most 100000 characters').optional(),
  images: z.array(attachmentInputSchema).max(4).optional(),
  runner: z.enum(RUNNER_IDS).optional(),
  model: z.string().max(200).optional(),
  /** Reasoning-effort pin (legacy reference 45). Omitted keeps the run's pin; empty string clears it. */
  effort: z.string().max(32).optional(),
  /** Agent account for the reopened session (spec 2026-07-29-agent-profiles). Bound mirrors
   *  `POST /runs`' own `agentProfile`. Omitted = keep the account the run is already on. */
  agentProfile: z.string().max(64).optional(),
});

// `POST /api/runs/:id/archive` (legacy reference 429) — no body archives; `{archived:false}`
// un-archives. A tiny schema so the route follows the safeParse convention.
export const archiveSchema = z.object({
  archived: z.boolean().optional(),
});

// "Open in…" (#open-in / legacy reference 365): `target` selects the app; `path` (optional, worktree-relative)
// narrows the target's own worktree/repo-root default to one file — used by the diff pane's
// "open in default app" action for images. Containment is re-checked server-side via
// `readWorktreePath`; this schema only shapes the request.
export const openInSchema = z.object({
  // A short bound (legacy reference 429): matched against a downstream allowlist, so an editor id is never long.
  target: z.string().trim().min(1, 'target required').max(200),
  path: z.string().max(1_000).optional(),
});
