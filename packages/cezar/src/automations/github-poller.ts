import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AutomationEvent, AutomationRuntimeState, GithubAutomationDefinition } from './types.ts';

const execFileAsync = promisify(execFile);
const HARD_CANDIDATE_CAP = 100;
const GITHUB_COMMAND_TIMEOUT_MS = 30_000;
/** Provider requests one history check may spend, its search included. */
const HISTORY_REQUEST_CAP = 10;
const TIMELINE_PAGE_SIZE = 100;
/** The timeline is oldest first, so a live poll reads every page up to this cap. */
const TIMELINE_PAGE_CAP = 10;

const githubItemSchema = z.object({
  id: z.number().int().positive().optional(),
  node_id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
  user: z.object({ login: z.string() }),
  assignees: z.array(z.object({ login: z.string() })).default([]),
  labels: z.array(z.object({ name: z.string() })).default([]),
  repository_url: z.string().url(),
  pull_request: z.unknown().optional(),
});

type GithubItem = z.infer<typeof githubItemSchema>;
type PollSource = { family: 'issues' | 'prs' | 'mixed'; activity: 'created' | 'updated'; opened: boolean; labels: boolean };
type Scan = NonNullable<AutomationRuntimeState['historyScan']>;

const searchResponseSchema = z.object({ items: z.array(githubItemSchema) });
const timelineEventSchema = z.object({
  id: z.number().int().positive().optional(),
  node_id: z.string().optional(),
  event: z.enum(['labeled', 'unlabeled']),
  created_at: z.string().datetime(),
  label: z.object({ name: z.string() }),
});

export interface GithubCandidate {
  eventId: string;
  event: AutomationEvent;
  timestamp: string;
  tieBreaker: string;
  repo: string;
  nodeId: string;
  number: number;
  title: string;
  url: string;
  author: string;
  assignees: string[];
  labels: string[];
  changedLabel?: string | undefined;
}

export interface GithubPollResult {
  candidates: GithubCandidate[];
  truncated: boolean;
  pages: number;
  cursor?: { timestamp: string; tieBreaker: string } | undefined;
  historyScan?: AutomationRuntimeState['historyScan'];
}

export interface GithubPollerOptions {
  run?: (executable: string, args: readonly string[]) => Promise<string>;
}

export interface GithubPollOptions {
  /** Execution eligibility, including baseline and durable receipts, before charging the item cap. */
  accept?: ((candidate: GithubCandidate) => boolean) | undefined;
  since?: string | undefined;
  historyScan?: AutomationRuntimeState['historyScan'];
}

/** A fresh eligibility read rejected the candidate before any task was created. */
export class AutomationCandidateChangedError extends Error {
  constructor() { super('Automation item is closed or no longer matches current labels; no task was created.'); }
}

export class GithubPoller {
  private readonly run: NonNullable<GithubPollerOptions['run']>;

  constructor(options: GithubPollerOptions = {}) {
    this.run = options.run ?? (async (executable, args) => (await execFileAsync(executable, [...args], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: GITHUB_COMMAND_TIMEOUT_MS,
    })).stdout);
  }

  /** Opt-in launch eligibility: require an open item and fresh labels, preserving historical events. */
  async matchesCurrentLabels(candidate: GithubCandidate, definition: GithubAutomationDefinition): Promise<boolean> {
    const raw = await this.run('gh', ['api', `repos/${candidate.repo}/issues/${candidate.number}`]);
    const issue = z.object({ state: z.enum(['open', 'closed']), labels: z.array(z.object({ name: z.string() })) }).parse(JSON.parse(raw));
    return issue.state === 'open' && matchesFilters({ ...candidate, labels: issue.labels.map(label => label.name) }, definition);
  }

  async poll(
    owner: string,
    repo: string,
    definition: GithubAutomationDefinition,
    options: GithubPollOptions = {},
  ): Promise<GithubPollResult> {
    const openedEvents = definition.events.filter(
      (event) => event === 'pull_request.opened' || event === 'issue.opened',
    );
    const labelEvents = definition.events.filter(
      (event) => event === 'issue.labeled' || event === 'issue.unlabeled',
    );
    const sources: PollSource[] = [];
    if (openedEvents.length) {
      sources.push({
        family: openedEvents.every((event) => event === 'pull_request.opened')
          ? 'prs'
          : openedEvents.every((event) => event === 'issue.opened') ? 'issues' : 'mixed',
        activity: 'created',
        opened: true,
        labels: false,
      });
    }
    if (labelEvents.length) {
      sources.push({ family: 'issues', activity: 'updated', opened: false, labels: true });
    }

    return this.pollScan(owner, repo, definition, sources, options);
  }

  /** Resume a fixed search window instead of letting overlap duplicates fill every page.
   * Each check accepts at most maxRecords new items and scans at most 100 items.
   * Provider requests have a separate bound. The successful live cursor moves only after every source is drained. */
  private async pollScan(
    owner: string,
    repo: string,
    definition: GithubAutomationDefinition,
    sources: PollSource[],
    options: GithubPollOptions,
  ): Promise<GithubPollResult> {
    const scan = startScan(definition, options);
    const candidates: GithubCandidate[] = [];
    let requests = 0;
    let evaluated = 0;
    const requestCap = definition.filters.includeExisting ? HISTORY_REQUEST_CAP : TIMELINE_PAGE_CAP + 1;
    let itemsRead = 0;
    const cap = Math.min(definition.filters.maxRecords, HARD_CANDIDATE_CAP);
    while (scan.source < sources.length && requests < requestCap && evaluated < cap && itemsRead < HARD_CANDIDATE_CAP) {
      const source = sources[scan.source]!;
      // Issue activity is mutable: comments must not evict unseen label transitions from
      // a frozen updated-time query. Revisit the full label lookback on each completed scan.
      const sourceSince = source.labels && definition.filters.includeExisting
        ? new Date(Date.parse(scan.until) - definition.filters.lookbackDays * 86_400_000).toISOString()
        : scan.since;
      const query = buildSearchQuery(owner, repo, definition, source.family, source.activity, sourceSince)
        + (source.labels ? '' : ` ${source.activity}:<=${scan.until}`);
      const raw = await this.run('gh', [
        'api', '--method', 'GET', '/search/issues', '-f', `q=${query}`,
        '-f', 'per_page=100', '-f', `page=${scan.page}`,
        // Label/assignee changes also move updated-time order. Creation order stays fixed.
        '-f', 'sort=created', '-f', 'order=asc',
      ]);
      requests++;
      const response = searchResponseSchema.parse(JSON.parse(raw));
      for (; scan.item < response.items.length && evaluated < cap && itemsRead < HARD_CANDIDATE_CAP; scan.item++) {
        const item = response.items[scan.item]!;
        itemsRead++;
        if (item.repository_url.toLowerCase() !== `https://api.github.com/repos/${owner}/${repo}`.toLowerCase()) continue;
        if (source.labels && requests >= requestCap) break;
        const budget = requestCap - requests;
        const batch = await this.scanRows(owner, repo, item, source, budget, sourceSince, scan.until);
        requests += batch.pages;
        if (!batch.complete) {
          // A fresh check must fit one complete timeline; partial remaining budgets resume next check.
          if (budget < requestCap - 1) break;
          throw incompleteHistory(owner, repo, item.number, budget);
        }
        const rows = batch.rows;
        evaluated += collectCandidates(scan, rows, candidates, cap - evaluated, definition, source, options);
        if (scan.event < rows.length) break;
        // Scan work stays bounded independently of the number of new matches.
        scan.event = 0;
      }
      if (scan.item < response.items.length) break;
      advanceScanPage(scan, response.items.length);
    }
    return scanResult(scan, sources.length, candidates, requests);
  }

  private async scanRows(owner: string, repo: string, item: GithubItem, source: PollSource,
    budget: number, since: string, until: string) {
    if (source.labels && item.pull_request) return { rows: [], pages: 0, complete: true };
    const timeline = source.labels ? await this.timeline(owner, repo, item.number, budget) : undefined;
    const rows = timeline ? reconstructLabelEvents(owner, repo, item, timeline.events)
      : [normalizeOpened(owner, repo, item, item.pull_request ? 'pull_request.opened' : 'issue.opened')];
    return {
      rows: rows.filter(row => Date.parse(row.timestamp) >= Date.parse(since) && Date.parse(row.timestamp) <= Date.parse(until)),
      pages: timeline?.pages ?? 0, complete: timeline?.complete ?? true,
    };
  }

  /** The timeline mixes comments, assignments, closures and more with label changes, oldest
   * first. Reads up to `maxPages` pages and validates and returns only label changes.
   * `complete` is false when the last page read was full: dropping unrelated entries does not
   * make a history complete (hearsay-tools/cezarion#1182). */
  private async timeline(owner: string, repo: string, number: number, maxPages: number) {
    const events: z.infer<typeof timelineEventSchema>[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const raw = await this.run('gh', [
        'api', '--method', 'GET', `repos/${owner}/${repo}/issues/${number}/timeline`,
        '-H', 'Accept: application/vnd.github+json',
        '-f', `per_page=${TIMELINE_PAGE_SIZE}`, '-f', `page=${page}`,
      ]);
      const entries = z.array(z.unknown()).parse(JSON.parse(raw));
      entries.forEach((entry, offset) => {
        const kind = typeof entry === 'object' && entry !== null ? (entry as { event?: unknown }).event : undefined;
        if (kind !== 'labeled' && kind !== 'unlabeled') return;
        const parsed = timelineEventSchema.safeParse(entry);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(entry)'}: ${issue.message}`).join('; ');
          const index = (page - 1) * TIMELINE_PAGE_SIZE + offset;
          throw new Error(`GitHub returned a malformed label change at ${owner}/${repo}#${number} timeline entry ${index} (${kind}): ${issues}`);
        }
        events.push(parsed.data);
      });
      if (entries.length < TIMELINE_PAGE_SIZE) return { events, pages: page, complete: true };
    }
    return { events, pages: maxPages, complete: false };
  }
}

function startScan(definition: GithubAutomationDefinition, options: GithubPollOptions): Scan {
  if (options.historyScan) return structuredClone(options.historyScan);
  const since = options.since ?? new Date(Date.now() - definition.filters.lookbackDays * 86_400_000).toISOString();
  return { since, until: new Date().toISOString(), source: 0, page: 1, item: 0, event: 0 };
}

function scanResult(scan: Scan, sources: number, candidates: GithubCandidate[], pages: number): GithubPollResult {
  const truncated = scan.source < sources;
  candidates.sort(compareObservation);
  const cursor = !truncated && scan.cursor?.tieBreaker !== undefined
    ? { timestamp: scan.cursor.timestamp, tieBreaker: scan.cursor.tieBreaker } : undefined;
  return { candidates, truncated, pages, cursor, ...(truncated ? { historyScan: scan } : {}) };
}

function collectCandidates(scan: Scan, rows: GithubCandidate[], candidates: GithubCandidate[], cap: number,
  definition: GithubAutomationDefinition, source: PollSource, options: GithubPollOptions): number {
  let evaluated = 0;
  for (; scan.event < rows.length && evaluated < cap; scan.event++) {
    const row = rows[scan.event]!;
    advanceScanCursor(scan, row, source.labels && !!definition.filters.includeExisting);
    const matches = definition.events.includes(row.event) && matchesFilters(row, definition);
    if (matches && (options.accept?.(row) ?? true)) {
      candidates.push(row);
      evaluated++;
    }
  }
  return evaluated;
}

function advanceScanCursor(scan: Scan, row: GithubCandidate, historicalLabels: boolean): void {
  if (historicalLabels) return;
  if (!scan.cursor || compareObservation(row, { ...scan.cursor, tieBreaker: scan.cursor.tieBreaker ?? '' }) > 0) {
    scan.cursor = { timestamp: row.timestamp, tieBreaker: row.tieBreaker };
  }
}

function advanceScanPage(scan: Scan, size: number): void {
  if (size >= 100) {
    if (scan.page >= 10) throw new Error('GitHub search reached its 1000-item limit; narrow the automation lookback or filters.');
    scan.page++;
  } else {
    scan.source++;
    scan.page = 1;
  }
  scan.item = 0;
  scan.event = 0;
}

export function buildSearchQuery(
  owner: string,
  repo: string,
  definition: GithubAutomationDefinition,
  family: 'issues' | 'prs' | 'mixed' = 'mixed',
  activity: 'created' | 'updated' = 'created',
  since?: string,
): string {
  const start = since
    ?? new Date(Date.now() - definition.filters.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const terms = [
    `repo:${owner}/${repo}`,
    family === 'prs' ? 'is:pr' : family === 'issues' ? 'is:issue' : '',
    `${activity}:>=${start}`,
  ];
  for (const author of definition.filters.authors ?? []) terms.push(`author:${safeQualifier(author)}`);
  // Apply mutable label/assignee filters locally. Removing either from a passed item
  // must not remove a search row and shift an unseen item behind the saved offset.
  // Label transitions also need reconstructed labels, independent of current labels.
  return terms.filter(Boolean).join(' ');
}

function incompleteHistory(owner: string, repo: string, number: number, pages: number): Error {
  return new Error(`GitHub issue ${owner}/${repo}#${number} has more label history than one check reads (${pages * TIMELINE_PAGE_SIZE} timeline entries); narrow the automation filters or process this item separately.`);
}

function safeQualifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '');
}

function normalizeOpened(owner: string, repo: string, item: z.infer<typeof githubItemSchema>, event: 'pull_request.opened' | 'issue.opened'): GithubCandidate {
  const eventId = `${owner}/${repo}:${item.node_id}:${event}:${item.created_at}`;
  return {
    eventId,
    event,
    timestamp: item.created_at,
    tieBreaker: item.node_id,
    repo: `${owner}/${repo}`,
    nodeId: item.node_id,
    number: item.number,
    title: sanitize(item.title, 500),
    url: item.html_url,
    author: item.user.login,
    assignees: item.assignees.map((assignee) => assignee.login),
    labels: item.labels.map((label) => label.name),
  };
}

export function reconstructLabelEvents(
  owner: string,
  repo: string,
  item: z.infer<typeof githubItemSchema>,
  timeline: z.infer<typeof timelineEventSchema>[],
): GithubCandidate[] {
  const current = new Set(item.labels.map((label) => label.name));
  const ordered = [...timeline].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows: GithubCandidate[] = [];
  for (const entry of ordered) {
    const postLabels = [...current];
    if (entry.event === 'labeled') current.delete(entry.label.name);
    else current.add(entry.label.name);
    const labels = entry.event === 'labeled' ? postLabels : [...current];
    const kind = entry.event === 'labeled' ? 'issue.labeled' : 'issue.unlabeled';
    const stable = entry.node_id ?? String(entry.id ?? `${entry.created_at}:${entry.label.name.toLowerCase()}`);
    rows.push({
      ...normalizeOpened(owner, repo, item, 'issue.opened'),
      event: kind,
      eventId: `${owner}/${repo}:${item.node_id}:${kind}:${stable}`,
      timestamp: entry.created_at,
      tieBreaker: stable,
      labels,
      changedLabel: entry.label.name,
    });
  }
  return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.tieBreaker.localeCompare(b.tieBreaker));
}

export function matchesFilters(candidate: GithubCandidate, definition: GithubAutomationDefinition): boolean {
  const lower = (values: readonly string[]) => new Set(values.map((value) => value.toLowerCase()));
  const labels = lower(candidate.labels);
  const filters = definition.filters;
  if (filters.authors?.length && !lower(filters.authors).has(candidate.author.toLowerCase())) return false;
  if (filters.assignees?.length && !candidate.assignees.some((value) => lower(filters.assignees!).has(value.toLowerCase()))) return false;
  if (filters.allLabels?.some((value) => !labels.has(value.toLowerCase()))) return false;
  if (filters.anyLabels?.length && !filters.anyLabels.some((value) => labels.has(value.toLowerCase()))) return false;
  if (filters.excludeLabels?.some((value) => labels.has(value.toLowerCase()))) return false;
  if (candidate.changedLabel && filters.changedLabels?.length && !lower(filters.changedLabels).has(candidate.changedLabel.toLowerCase())) return false;
  return true;
}

function sanitize(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

function compareObservation(
  a: { timestamp: string; tieBreaker: string },
  b: { timestamp: string; tieBreaker: string },
): number {
  return a.timestamp.localeCompare(b.timestamp) || a.tieBreaker.localeCompare(b.tieBreaker);
}
