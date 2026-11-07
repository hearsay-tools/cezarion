import { z } from 'zod';
import type { ForgeTimelineEvent, ForgeTimelineEventKind } from './types.ts';

// ---- timeline events (hearsay-tools/cezarion#525) -------------------------------------------------
// The thread's non-comment history — commits, label changes, assignments, merges, force-pushes,
// cross-references. Sourced from `/issues/{n}/timeline`, which returns comments AND events in one
// chronological stream, so the `commented` rows keep flowing through `normalizeComments` unchanged
// and `comments[]` keeps its existing shape.

/** The event kinds rendered in v1 — an allowlist, so a new GitHub event type is dropped rather
 *  than rendered and can never crash or clutter the thread. Real timelines carry plenty that
 *  github.com itself doesn't surface (`subscribed`, `mentioned`, `review_requested`).
 *
 *  `reviewed` is deliberately absent: timeline `reviewed` rows DO carry a body and would work,
 *  but `/pulls/{n}/reviews` is already normalized, chipped and empty-body-filtered, so sourcing
 *  both would render every review twice. */
export const TIMELINE_EVENT_KINDS = new Set<ForgeTimelineEventKind>([
  'committed',
  'labeled',
  'unlabeled',
  'assigned',
  'unassigned',
  'merged',
  'closed',
  'reopened',
  'head_ref_force_pushed',
  'cross-referenced',
  'renamed',
]);

/** Events get their OWN cap, independent of `THREAD_ENTRY_CAP`. A combined cap would mean a
 *  thread with 150 comments and 100 events returns ~120 comments — silently removing contents
 *  from a §2-protected response. */
export const TIMELINE_EVENT_CAP = 200;
/** `gh api --paginate` has no page limit, so the timeline fetch hand-rolls a bounded loop. */
export const TIMELINE_MAX_PAGES = 10;
/** ONE budget shared by every page. `gh()`'s timeout is per invocation, so ten pages at the 15 s
 *  default would put the ceiling at 150 s — an order of magnitude worse than the single
 *  `--paginate` spawn this replaces. The loop tracks a deadline and passes what's left. */
export const TIMELINE_BUDGET_MS = 15_000;
/** Never spawn a page that cannot finish. A bare `remaining <= 0` guard catches only the exact
 *  boundary; the realistic case is 300 ms left, which spawns `gh` with a 300 ms timeout, throws,
 *  and is indistinguishable from a real endpoint failure. */
export const TIMELINE_MIN_PAGE_MS = 2_000;
/** `committed` messages are trimmed to their first line, then this. */
const COMMIT_MESSAGE_CAP = 120;

/** One timeline row. `event` stays a loose `z.string()` so unknown kinds parse and are dropped by
 *  the allowlist rather than throwing the whole page. Extras are stripped by default — notably
 *  `author.email`, which is read for nothing and must not reach the wire type. */
export const ghTimelineEventSchema = z.object({
  event: z.string(),
  id: z.number().nullish(),
  node_id: z.string().nullish(),
  created_at: z.string().nullish(),
  actor: z.object({ login: z.string(), avatar_url: z.string().nullish() }).nullish(),
  url: z.string().nullish(),
  html_url: z.string().nullish(),
  // `committed`
  sha: z.string().nullish(),
  message: z.string().nullish(),
  author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
  // `labeled` / `unlabeled`
  label: z.object({ name: z.string(), color: z.string().nullish() }).nullish(),
  // `assigned` / `unassigned`
  assignee: z.object({ login: z.string() }).nullish(),
  // `renamed`
  rename: z.object({ from: z.string().nullish(), to: z.string().nullish() }).nullish(),
  // `cross-referenced`
  source: z
    .object({
      issue: z
        .object({
          number: z.number().nullish(),
          title: z.string().nullish(),
          html_url: z.string().nullish(),
          pull_request: z.unknown().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/**
 * `gh api …/issues/{n}/timeline` JSON → `ForgeTimelineEvent[]`, plus whether the cap fired.
 *
 * Returns `truncated` rather than just the array because the caller has no other way to learn it:
 * `events.length === TIMELINE_EVENT_CAP` is ambiguous on a thread with exactly that many.
 *
 * Three details here are load-bearing and were verified against a real timeline, not assumed:
 *
 * 1. **`committed` rows return `created_at: null`** — the real timestamp is at `author.date`.
 *    Mapping `created_at` naively yields `createdAt: null` on every commit, which string-sorts to
 *    the top and silently reorders the entire thread.
 * 2. **`committed` carries a git author, not a GitHub actor** — a name, no login, no avatar.
 * 3. **The cap keeps the NEWEST events — `slice(-cap)`**, the opposite of the neighbouring
 *    `mergeThread`, which head-slices. The timeline arrives oldest-first, so `slice(0, cap)` would
 *    retain 200 stale day-one `labeled` rows and discard the merge and the recent commits — the
 *    exact rows hearsay-tools/cezarion#525 asks for.
 *
 * Exported for unit tests.
 */
export function normalizeEvents(
  raw: unknown,
  cap = TIMELINE_EVENT_CAP,
): { events: ForgeTimelineEvent[]; truncated: boolean } {
  const rows = z.array(ghTimelineEventSchema).parse(raw);
  const mapped: ForgeTimelineEvent[] = [];

  rows.forEach((row, index) => {
    const kind = row.event as ForgeTimelineEventKind;
    if (!TIMELINE_EVENT_KINDS.has(kind)) return; // unknown//noise → dropped, never rendered

    // Per-kind timestamp resolution — see (1) above.
    const rawAt = kind === 'committed' ? row.author?.date : row.created_at;
    if (!rawAt) return; // no resolvable timestamp → drop, rather than merge at an arbitrary spot
    // `author.date` arrives with a numeric offset (`+02:00`); normalize so the string compare the
    // thread sorts by stays correct across zones.
    const parsedAt = new Date(rawAt);
    if (Number.isNaN(parsedAt.getTime())) return;
    const createdAt = parsedAt.toISOString();

    // Per-kind actor resolution — see (2) above.
    const actor = (kind === 'committed' ? row.author?.name : row.actor?.login) ?? '?';

    // Identity: `sha` sits ahead of `node_id` deliberately. `committed` rows carry both, and a
    // node_id-first order would key commits by an opaque `C_kwDO…` blob instead of the SHA, which
    // is the natural, debuggable identifier and is already the rollup key. The bare-index fallback
    // reaches only `cross-referenced`, the one kind with no identity at all — as a general scheme
    // it would be wrong, since the id becomes the React key and an index over the post-sort array
    // shifts for every row below an insertion, remounting them on each 60 s refetch.
    const identity = row.id ?? row.sha ?? row.node_id ?? index;

    const event: ForgeTimelineEvent = {
      id: `evt-${identity}`,
      kind,
      actor,
      createdAt,
    };
    // A git author has no avatar, so `committed` deliberately carries none.
    if (kind !== 'committed' && row.actor?.avatar_url) event.avatarUrl = row.actor.avatar_url;

    switch (kind) {
      case 'committed': {
        // Enforce the full-40-hex invariant the rollup query depends on rather than assuming it:
        // `oid` rejects anything else, and a malformed value embedded in the batched query would
        // cost the whole chunk its glyphs instead of just this commit.
        if (row.sha && /^[0-9a-f]{40}$/i.test(row.sha)) event.sha = row.sha;
        if (row.message) event.message = (row.message.split('\n')[0] ?? '').slice(0, COMMIT_MESSAGE_CAP);
        if (row.html_url) event.url = row.html_url;
        break;
      }
      case 'labeled':
      case 'unlabeled': {
        if (row.label) {
          event.label = { name: row.label.name };
          if (row.label.color) event.label.color = row.label.color;
        }
        break;
      }
      case 'assigned':
      case 'unassigned': {
        if (row.assignee?.login) event.subject = row.assignee.login;
        break;
      }
      case 'renamed': {
        if (row.rename?.to) event.subject = row.rename.to;
        break;
      }
      case 'cross-referenced': {
        const issue = row.source?.issue;
        if (issue?.number != null) event.refNumber = issue.number;
        if (issue?.title) event.refTitle = issue.title;
        if (issue) event.refIsPr = Boolean(issue.pull_request);
        if (issue?.html_url) event.url = issue.html_url;
        break;
      }
      default:
        break;
    }

    mapped.push(event);
  });

  const truncated = mapped.length > cap;
  // slice(-cap), NOT slice(0, cap) — see (3) above.
  return { events: truncated ? mapped.slice(-cap) : mapped, truncated };
}

export const TIMELINE_PER_PAGE = 100;

/** What the bounded timeline page loop returns. `stoppedShort` means "the timeline may have more
 *  rows than we fetched" and has exactly three causes — the page cap, the budget floor, and a
 *  failure on page ≥ 2. All three shorten the `commented` stream the same way, so all three feed
 *  `truncated` and arm the comments top-up; the cause does not change the remedy. A short page is
 *  the one exit that does NOT set it: that is the timeline genuinely ending. */
export type TimelinePages = { rows: unknown[]; stoppedShort: boolean };

/**
 * Walk `/issues/{n}/timeline` under ONE shared time budget.
 *
 * `gh api --paginate` is not used here: it pages *"until there are no more pages of results"* and
 * exposes no page-limit flag, so the only way to bound the walk is to hand-roll it. The cap that
 * `paginateCounts` gets comes from being a JS cursor loop, not from a `gh` flag.
 *
 * The budget is a **total**, not a per-page allowance. `gh()` takes its timeout per invocation, so
 * ten sequential spawns at the 15 s default would put the ceiling at 150 s — an order of magnitude
 * worse than the single `--paginate` spawn this replaces. The loop tracks a deadline and passes
 * each page whatever remains.
 *
 * Exported for unit tests; `run` is injected so the loop is testable without shelling out.
 */
export async function fetchTimelinePages(
  run: (page: number, timeoutMs: number) => Promise<string>,
  opts: { maxPages?: number; budgetMs?: number; minPageMs?: number; now?: () => number } = {},
): Promise<TimelinePages> {
  const maxPages = opts.maxPages ?? TIMELINE_MAX_PAGES;
  const budgetMs = opts.budgetMs ?? TIMELINE_BUDGET_MS;
  const minPageMs = opts.minPageMs ?? TIMELINE_MIN_PAGE_MS;
  const now = opts.now ?? Date.now;

  const deadline = now() + budgetMs;
  const rows: unknown[] = [];
  let stoppedShort = false;
  let page = 1;

  for (; page <= maxPages; page++) {
    const remaining = deadline - now();
    // Never spawn a page that cannot finish. A bare `remaining <= 0` guard catches only the exact
    // boundary; the realistic case is 300 ms left, which spawns gh with a 300 ms timeout, throws,
    // and looks indistinguishable from a real endpoint failure.
    if (remaining < minPageMs) {
      stoppedShort = true;
      break;
    }
    let parsed: unknown[];
    try {
      parsed = z.array(z.unknown()).parse(JSON.parse(await run(page, remaining)));
    } catch (err) {
      // Page 1 rethrows so the caller's inner catch can decide whether substitution helps —
      // nothing was fetched, so there is nothing to lose. A failure on any later page keeps the
      // pages already in hand: discarding nine good pages to re-fetch comments-only is strictly
      // worse than what the loop already holds.
      if (page === 1) throw err;
      stoppedShort = true;
      break;
    }
    rows.push(...parsed);
    if (parsed.length < TIMELINE_PER_PAGE) break; // short page — the real end of the timeline
  }
  if (page > maxPages) stoppedShort = true; // fell out on the page cap

  return { rows, stoppedShort };
}
