import { z } from 'zod';
import { repoInfoSchema } from './health.ts';
import { runStatusSchema } from './runs.ts';

/**
 * The repo / git family of `/api/v1` — the Repo view, the structured diff shapes the Changes and
 * Files tabs read, and the worktree-retention panel.
 *
 * `RepoInfo` is NOT redeclared here: health already owns it (`./health.ts`), and the Repo view
 * serves the very same record.
 */

/** One `git status --porcelain` row. */
export const statusEntrySchema = z.object({
  status: z.string(),
  path: z.string(),
});
export type StatusEntry = z.infer<typeof statusEntrySchema>;

/** The task a base-branch commit came from (issue 08 §B5). Best effort: a merge commit maps its
 *  second parent to a run by `branch`, a squash commit maps a trailing `(#123)` to a run by
 *  `pullRequestUrl`. `prNumber` is the PR that landed it, when one is known. */
export const logEntrySourceSchema = z.object({
  runId: z.string(),
  title: z.string(),
  prNumber: z.number().nullable(),
});
export type LogEntrySource = z.infer<typeof logEntrySourceSchema>;

/** One `git log` row; `when` is git's relative `%cr` ("3 hours ago"), not a timestamp. `source`
 *  is ABSENT (never `null`) when no task is known to have produced the commit. */
export const logEntrySchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  when: z.string(),
  source: logEntrySourceSchema.optional(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/**
 * `GET /api/v1/repo` — the Repo view's one read.
 *
 * A union, and deliberately so: the handler answers a DIFFERENT object when the project root is
 * not a repository (`server.ts:3481`) than when it is (`server.ts:3494`), and the empty branch's
 * `[]` literals make its arrays `never[]` in the route type. Modelling this as the flat
 * `{ info: RepoInfo | null; status: StatusEntry[]; … }` the hand-written DTO used would be WIDER
 * than the route — the parity guard rejects it. Both members still parse the real wire bytes
 * (an empty array satisfies `z.array(z.never())`), so nothing is lost at runtime; it is the
 * compile-time shape that is oddly precise. See the report note on `server.ts:3481`.
 */
/**
 * How the base branch stands against its upstream (issue 08 §B1), as of the LAST FETCH: no request
 * ever fetches. `ref` is the upstream's short name (`origin/main`); `ahead`/`behind` count commits
 * only on the base / only on the upstream; `fetchedAt` is the mtime of `FETCH_HEAD`, or null when
 * the repository has never fetched. The whole field is null when the base has no upstream.
 */
export const repoTrackingSchema = z.object({
  ref: z.string(),
  ahead: z.number(),
  behind: z.number(),
  fetchedAt: z.string().nullable(),
});
export type RepoTracking = z.infer<typeof repoTrackingSchema>;

export const repoResponseSchema = z.union([
  z.object({
    info: z.null(),
    status: z.array(z.never()),
    log: z.array(z.never()),
    branches: z.array(z.never()),
    baseBranch: z.null(),
    tracking: z.null(),
  }),
  z.object({
    info: repoInfoSchema,
    status: z.array(statusEntrySchema),
    log: z.array(logEntrySchema),
    branches: z.array(z.string()),
    baseBranch: z.string().nullable(),
    tracking: repoTrackingSchema.nullable(),
  }),
]);
export type RepoResponse = z.infer<typeof repoResponseSchema>;

/** `POST /api/v1/repo/branch` — switch to an existing branch, or create one and switch. Every
 *  predictable git failure (invalid name, unknown `from`, dirty-tree conflict) is a 409. */
export const repoBranchResponseSchema = z.object({
  branch: z.string(),
  created: z.boolean(),
});
export type RepoBranchResponse = z.infer<typeof repoBranchResponseSchema>;

/**
 * Where a local branch stands (issue 08 §A). Classified once, on the server:
 *
 * - `active` — its run is live or not yet finished (queued, running, waiting, monitoring, `review`),
 *   it is protected by an owned-workspace receipt, it is checked out in any worktree, or it is the
 *   current or base branch. Never deletable.
 * - `not-landed` — its run is finished (or archived), it has commits the base does not, and no PR
 *   from it merged. Deletable one at a time, with a typed confirmation.
 * - `orphan` — a `cez/*` branch no run names, with commits the base does not and no merged PR.
 *   Same deletion rule as `not-landed`: the branch may be the only copy of the work.
 * - `merged` — its tip is reachable from the base, or a PR from it merged (squash merges are not
 *   ancestors). Bulk-deletable.
 * - `empty` — its run exists and the tip is still the run's fork point. Bulk-deletable.
 * - `other` — not `cez/*`: the user's own branch. Never deletable from this surface.
 */
export const branchClassSchema = z.enum(['active', 'not-landed', 'orphan', 'merged', 'empty', 'other']);
export type BranchClass = z.infer<typeof branchClassSchema>;

export const branchPrStateSchema = z.enum(['open', 'draft', 'merged', 'closed']);
export type BranchPrState = z.infer<typeof branchPrStateSchema>;

export const repoBranchEntrySchema = z.object({
  name: z.string(),
  class: branchClassSchema,
  runId: z.string().nullable(),
  title: z.string().nullable(),
  runStatus: runStatusSchema.nullable(),
  /** Commits on the branch that are not reachable from the base. */
  ahead: z.number(),
  lastCommit: z.object({ sha: z.string(), subject: z.string(), at: z.string() }),
  /** `--shortstat <base>...<branch>`, for `not-landed` and `orphan` rows only. */
  diffStat: z.object({ additions: z.number(), deletions: z.number() }).nullable(),
  pr: z.object({ number: z.number(), url: z.string(), state: branchPrStateSchema }).nullable(),
});
export type RepoBranchEntry = z.infer<typeof repoBranchEntrySchema>;

/**
 * `GET /api/v1/repo/branches` — every local branch, classified. `base` is the ref the classes were
 * measured against (`origin/<base>` when the local base is behind it). `prStateKnown` is false when
 * the forge could not answer (no `gh`, offline, no remote): squash-merged branches may then read as
 * `not-landed`, never the other way round. `counts.cleanup` is `merged` + `empty`. A directory that
 * is not a repository answers an empty list, never an error.
 */
export const repoBranchesResponseSchema = z.object({
  base: z.string(),
  prStateKnown: z.boolean(),
  branches: z.array(repoBranchEntrySchema),
  counts: z.object({ notLanded: z.number(), cleanup: z.number() }),
});
export type RepoBranchesResponse = z.infer<typeof repoBranchesResponseSchema>;

/** `POST /api/v1/repo/branches/delete`. `confirm` must equal the branch name to delete a
 *  `not-landed` or `orphan` branch, which is only ever deleted alone. */
export const deleteBranchesInputSchema = z.object({
  names: z.array(z.string().trim().min(1).max(250)).min(1).max(500),
  confirm: z.string().optional(),
});
export type DeleteBranchesInput = z.infer<typeof deleteBranchesInputSchema>;

export const branchRefusalSchema = z.object({ name: z.string(), reason: z.string() });
export type BranchRefusal = z.infer<typeof branchRefusalSchema>;

/**
 * The delete answer. The server re-classifies every name at delete time and never trusts the
 * client: `merged`/`empty` go in bulk, everything else lands in `refused` with its reason.
 * `dropped` names the commits a confirmed `not-landed`/`orphan` delete threw away (newest first,
 * at most 100) and is absent on every other answer. 200 when anything was deleted; 409 with the
 * same `refused` list and an `error` when nothing was.
 */
export const deleteBranchesResponseSchema = z.object({
  deleted: z.array(z.string()),
  refused: z.array(branchRefusalSchema),
  dropped: z.array(z.object({ sha: z.string(), subject: z.string() })).optional(),
});
export type DeleteBranchesResponse = z.infer<typeof deleteBranchesResponseSchema>;

export const deleteBranchesErrorSchema = z.object({
  error: z.string(),
  refused: z.array(branchRefusalSchema),
});
export type DeleteBranchesError = z.infer<typeof deleteBranchesErrorSchema>;

/** Local branches eligible for the project checkout's Pull picker. */
export const repoPullBranchesResponseSchema = z.object({ branches: z.array(z.string()) });
export type RepoPullBranchesResponse = z.infer<typeof repoPullBranchesResponseSchema>;

export const repoPullInputSchema = z.object({
  branch: z.string().trim().min(1).max(200).optional(),
  confirm: z.boolean().optional(),
});
export type RepoPullInput = z.infer<typeof repoPullInputSchema>;

export const repoPullResponseSchema = z.object({
  branch: z.string(),
  pulled: z.literal(true),
  summary: z.string(),
});
export type RepoPullResponse = z.infer<typeof repoPullResponseSchema>;

/** A 409 that can be retried after acknowledging the named risks. */
export const repoPullConfirmationSchema = z.object({
  error: z.string(),
  branch: z.string(),
  risks: z.array(z.enum(['active_runs', 'dirty_tree'])),
});
export type RepoPullConfirmation = z.infer<typeof repoPullConfirmationSchema>;
export const repoPullErrorSchema = z.union([
  repoPullConfirmationSchema,
  z.object({ error: z.string() }),
]);
export type RepoPullError = z.infer<typeof repoPullErrorSchema>;

/** The aggregate line counts every structured-diff payload carries. Module-local: the runs family
 *  carries its own `DiffStat` of the same shape, and two `export`s of one name would collide when
 *  `contract/index.ts` re-exports both files. */
const diffStatSchema = z.object({
  adds: z.number(),
  dels: z.number(),
  files: z.number(),
});

/** One changed file of a structured diff (`/runs/:id/changes`, `/repo/changes`, the commit
 *  routes). Assignable to the diff facade's `DiffFileChange` by construction. */
export const changedFileSchema = z.object({
  path: z.string(),
  /** Rename/copy source — present only when `status` is renamed/copied. */
  oldPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied']),
  adds: z.number(),
  dels: z.number(),
  /** Binary per numstat — there is no text patch to render. */
  binary: z.boolean(),
  /** True when the path is one the raw-bytes route serves as an `<img>` (#365) — present only
   *  when true, so old clients that never read it stay correct. */
  image: z.boolean().optional(),
  /** This file's unified-diff section; possibly `… (patch truncated)`, possibly empty. */
  patch: z.string(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

/** `GET /api/v1/runs/:id/changes` and `GET /api/v1/repo/changes` — the structured diff.
 *  409 (+ reason) when the run's backing directory is unavailable or git itself refuses; never HTML. */
export const changesPayloadSchema = z.object({
  files: z.array(changedFileSchema),
  stat: diffStatSchema,
  /** Additive context for review tasks whose worktree HEAD no longer matches their own branch. */
  repointedHead: z.object({ headBranch: z.string(), taskBranch: z.string() }).optional(),
});
export type ChangesPayload = z.infer<typeof changesPayloadSchema>;

/** `GET /api/v1/repo/commit/:sha?structured=1` (and `/runs/:id/commit/:sha`) — one commit's
 *  metadata plus the same `{files, stat}` shape the /changes routes serve. A merge commit
 *  honestly answers zero files. The bare (unstructured) route keeps its legacy text shape. */
export const repoCommitPayloadSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  /** Relative time ("3 hours ago") — same `%cr` format as the /api/v1/repo log. */
  when: z.string(),
  files: z.array(changedFileSchema),
  stat: diffStatSchema,
});
export type RepoCommitPayload = z.infer<typeof repoCommitPayloadSchema>;

/** One row of a `GET /api/v1/runs/:id/files` directory listing. */
export const worktreeDirEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['dir', 'file']),
  size: z.number().optional(),
});
export type WorktreeDirEntry = z.infer<typeof worktreeDirEntrySchema>;

/**
 * `GET /api/v1/runs/:id/files?path=` — a directory listing or one file (size-capped, binary
 * flagged). `content` is absent exactly when `binary` or `tooLarge`.
 *
 * A discriminated union on `type`. Both handlers now build their literal with `as const`; without
 * it the property widened to `string` during Hono's route-type inference and the route lost the
 * discriminant, so a consumer narrowing on `entry.type === 'dir'` was left with `never`.
 */
export const worktreeEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dir'),
    path: z.string(),
    entries: z.array(worktreeDirEntrySchema),
  }),
  z.object({
    type: z.literal('file'),
    path: z.string(),
    size: z.number(),
    binary: z.boolean(),
    tooLarge: z.boolean(),
    content: z.string().optional(),
  }),
]);
export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;

/**
 * The lifecycle states a task can be in. Declared here (module-local, not exported) only because
 * `GET /api/v1/worktrees` echoes a run's `status` verbatim and the runs family's own contract
 * module does not exist yet — replace with that module's `runStatusSchema` when it lands.
 */
const worktreeRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
]);

/** One materialized task worktree in the management panel (#483). `sizeBytes` is null when `du`
 *  is unavailable (Windows / missing). `reclaimable` = finished, has a directory, not yet
 *  reclaimed (retention's rule). */
export const worktreeInfoSchema = z.object({
  runId: z.string(),
  title: z.string(),
  status: worktreeRunStatusSchema,
  branch: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  finishedAt: z.string().nullable(),
  reclaimable: z.boolean(),
});
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>;

/** `GET /api/v1/worktrees` (#483): the worktrees on disk, their total size (null when any
 *  degraded), and the current keep-limit (0 = unlimited). */
export const worktreesResponseSchema = z.object({
  worktrees: z.array(worktreeInfoSchema),
  totalBytes: z.number().nullable(),
  keep: z.number(),
});
export type WorktreesResponse = z.infer<typeof worktreesResponseSchema>;

/** `POST /api/v1/worktrees/:runId/reclaim` (issue 08 §B4): one run's worktree DIRECTORY reclaimed
 *  by retention's own rule and helper; the `cez/<id8>` branch is kept. 409 + `{error}` when the
 *  run is not reclaimable (live, at `review`, an owned worker mid-destroy, already reclaimed). */
export const reclaimWorktreeResponseSchema = z.object({
  runId: z.string(),
  worktreeReclaimedAt: z.string(),
});
export type ReclaimWorktreeResponse = z.infer<typeof reclaimWorktreeResponseSchema>;

/** `POST /api/v1/worktrees/reclaim` (#483): the run ids whose directory was reclaimed. */
export const reclaimWorktreesResponseSchema = z.object({
  reclaimed: z.array(z.string()),
});
export type ReclaimWorktreesResponse = z.infer<typeof reclaimWorktreesResponseSchema>;
