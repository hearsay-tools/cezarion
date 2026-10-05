/**
 * Deterministic `runs.json` fixtures for the run-store benchmark (#779,
 * `scripts/benchmark-run-store.ts`). Pure data: no store, no file system.
 *
 * Modeled on the 712-run local sample recorded on #779: 18.5 MB, median record 6.2 KB, largest
 * 363 KB, 698 archived, 701 with `delegation`; bytes by field: systemPrompt 7.75 MB, delegation
 * 3.26 MB, agentInputs 2.39 MB, task 1.94 MB, steps 0.58 MB, lastCiWait 0.21 MB. Shapes follow
 * a real index: roots own up to a handful of workers, root delegation carries the conversation
 * (the long tail), workers carry their parent's inputs and, before #778, a copy of the parent's
 * expanded skill as `systemPrompt` (12 distinct texts, 2-86 KB, the largest on 46 of 128 workers).
 * At 712 runs with the default seed the legacy profile writes 17.2 MB (systemPrompt 8.0, delegation
 * 3.0, agentInputs 2.5, task 1.7, steps 0.5 MB), median record 9.8 KB, largest 235 KB. The median
 * runs above the sample's 6.2 KB and matches today's 875-run file (8.9 KB).
 *
 * Profiles share every random draw, so they differ only in worker `systemPrompt`:
 * - `legacy`: workers spawned by a skill-driven parent copy its expanded skill (pre-#778).
 * - `post-778`: #778 (cf17f693) did not deduplicate the copy, it dropped it. A worker inherits only
 *   the parent's extra system prompt, which few runs set; legacy records keep their inline copy
 *   until retention removes them, so this profile models a file written entirely after #778.
 *
 * The `runs` records are finished (`done`/`cancelled`/`failed`, `review` for the few unarchived
 * rows). On top of them sits a live share of max(3, ceil(1% of runs)) records, newest first:
 * repeating groups of one `waiting` root with up to two `running` workers, one `queued` run and one
 * `running` run. It draws from its own seeded stream, so the finished records keep the bytes and
 * ids the first benchmark table measured; `serve` opens with `keepLive`, which leaves them live.
 */
import type { RunRecord } from '../src/runs/store.ts';

export const FIXTURE_PROFILES = ['legacy', 'post-778'] as const;
export type FixtureProfile = typeof FIXTURE_PROFILES[number];
export const DEFAULT_FIXTURE_SEED = 779;
const LIVE_STATUSES: ReadonlyArray<RunRecord['status']> = ['queued', 'running', 'waiting'];

/** Live (`queued`/`running`/`waiting`) records added on top of `runs` finished ones. */
export const liveRunCount = (runs: number) => Math.max(3, Math.ceil(runs * 0.01));
export const isLiveRun = (run: RunRecord) => LIVE_STATUSES.includes(run.status);

/** Sizes (chars) and weights of the distinct worker skill prompts in the sample (#778). */
const SKILL_PROMPTS: ReadonlyArray<{ chars: number; weight: number }> = [
  { chars: 86_157, weight: 36 }, { chars: 83_049, weight: 18 }, { chars: 72_587, weight: 14 },
  { chars: 56_001, weight: 12 }, { chars: 51_315, weight: 10 }, { chars: 13_914, weight: 6 },
  { chars: 12_526, weight: 6 }, { chars: 11_870, weight: 6 }, { chars: 5_421, weight: 4 },
  { chars: 1_926, weight: 3 }, { chars: 1_839, weight: 2 }, { chars: 40, weight: 1 },
];

class Rng {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(items: readonly T[]): T { return items[this.int(0, items.length - 1)]!; }
  weighted<T extends { weight: number }>(items: readonly T[]): T {
    let roll = this.next() * items.reduce((sum, item) => sum + item.weight, 0);
    for (const item of items) if ((roll -= item.weight) < 0) return item;
    return items[items.length - 1]!;
  }
  /** Log-normal by median and 90th percentile, clamped: the long tail of real record sizes. */
  logNormal(median: number, p90: number, min: number, max: number): number {
    const u = Math.max(this.next(), 1e-12);
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
    const value = median * Math.exp((Math.log(p90 / median) / 1.2816) * z);
    return Math.round(Math.min(max, Math.max(min, value)));
  }
  hex(length: number): string {
    let out = '';
    while (out.length < length) out += Math.floor(this.next() * 0x1_0000_0000).toString(16).padStart(8, '0');
    return out.slice(0, length);
  }
  uuid(): string {
    const h = this.hex(32);
    const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}

const WORDS = ('the run worker parent task skill review issue branch commit test fixture store index save ' +
  'open read write session agent prompt step delegation conversation request reply outcome wait ' +
  'verify gate draft merge build typecheck cockpit project workspace event stream record field ' +
  '`packages/cezar/src/runs/store.ts` `npm test` "quoted" **bold** - 1. ## Heading > note').split(' ');

let corpus: string | undefined;
/** 256 KB of markdown-ish text with newlines and quotes, so serialization has escaping to do. */
function textCorpus(): string {
  if (corpus) return corpus;
  const rng = new Rng(0xc0ffee);
  const parts: string[] = [];
  let length = 0;
  while (length < 256 * 1024) {
    const word = rng.pick(WORDS);
    const sep = rng.chance(0.07) ? '\n' : ' ';
    parts.push(word, sep);
    length += word.length + 1;
  }
  return (corpus = parts.join(''));
}

function text(rng: Rng, chars: number): string {
  const source = textCorpus();
  let out = '';
  let offset = rng.int(0, source.length - 1);
  while (out.length < chars) {
    out += source.slice(offset, offset + chars - out.length);
    offset = 0;
  }
  return out.trim().length > 0 ? out : 'x'.repeat(Math.max(chars, 1));
}

const line = (rng: Rng, chars: number) => text(rng, chars).replace(/\s+/g, ' ').trim() || 'Task';
const iso = (ms: number) => new Date(ms).toISOString();
const REPO = 'https://github.com/example-org/example-repo';
const MINUTE = 60_000;

interface Draft { record: RunRecord; skillPrompt?: string; extraPrompt?: string }

/**
 * `runs` finished records plus `liveRunCount(runs)` live ones, newest first (the order `RunStore`
 * writes). Same inputs, same bytes.
 */
export function generateRunFixture(options: { runs: number; profile: FixtureProfile; seed?: number }): RunRecord[] {
  const rng = new Rng((options.seed ?? DEFAULT_FIXTURE_SEED) * 1_000_003 + options.runs);
  const skillPrompts = SKILL_PROMPTS.map((entry) => ({ weight: entry.weight, text: text(rng, entry.chars) }));
  const drafts: Draft[] = [];
  const end = Date.UTC(2026, 9, 1);
  const createdAt = (seq: number) => end - (options.runs - seq) * 7 * MINUTE;

  while (drafts.length < options.runs) {
    if (rng.chance(0.015)) { drafts.push({ record: plainRun(rng, createdAt(drafts.length)) }); continue; }
    const roll = rng.next();
    const workers = roll < 0.5 ? 0 : roll < 0.66 ? 1 : roll < 0.78 ? 2 : roll < 0.87 ? 3 : roll < 0.93 ? 4 : rng.int(5, 8);
    const skillDriven = rng.chance(0.28);
    const rootId = rng.uuid();
    const workerIds = Array.from({ length: Math.min(workers, options.runs - drafts.length - 1) }, () => rng.uuid());
    drafts.push({ record: rootRun(rng, rootId, workerIds, createdAt(drafts.length)) });
    for (const workerId of workerIds) {
      const draft = workerRun(rng, workerId, rootId, createdAt(drafts.length));
      // Always draw both, so the two profiles consume the same stream.
      const skill = rng.weighted(skillPrompts).text;
      const extra = rng.chance(0.1) ? text(rng, rng.logNormal(400, 2_000, 40, 4_000)) : undefined;
      if (skillDriven) draft.skillPrompt = skill;
      draft.extraPrompt = extra;
      drafts.push(draft);
    }
  }

  const unarchived = Math.ceil(options.runs * 0.02);
  const finished = drafts.map((draft, index) => {
    const record = withSystemPrompt(draft, options.profile);
    if (index >= options.runs - unarchived) {
      record.archived = false;
      if (record.status === 'done') record.status = 'review';
    } else {
      record.archived = true;
      record.archivedAt = iso(Date.parse(record.finishedAt ?? record.createdAt) + 3 * 24 * 60 * MINUTE);
    }
    return record;
  }).reverse();
  const live = liveRuns(new Rng((options.seed ?? DEFAULT_FIXTURE_SEED) * 1_000_003 + options.runs + 0x11fe),
    skillPrompts, liveRunCount(options.runs), end).map((draft) => withSystemPrompt(draft, options.profile));
  return [...live.reverse(), ...finished];
}

function withSystemPrompt(draft: Draft, profile: FixtureProfile): RunRecord {
  const systemPrompt = profile === 'legacy' ? draft.skillPrompt ?? draft.extraPrompt : draft.extraPrompt;
  if (systemPrompt !== undefined) draft.record.systemPrompt = systemPrompt;
  return draft.record;
}

/** `count` live records, oldest first, created after `end` (every finished record). */
function liveRuns(rng: Rng, skillPrompts: ReadonlyArray<{ weight: number; text: string }>, count: number, end: number): Draft[] {
  const drafts: Draft[] = [];
  const at = () => end + (drafts.length + 1) * MINUTE;
  const goLive = (record: RunRecord, status: RunRecord['status']): RunRecord => {
    record.status = status;
    delete record.finishedAt;
    delete record.error;
    delete record.seenAt;
    if (status === 'queued') delete record.startedAt;
    for (const step of record.steps) {
      step.status = status === 'queued' ? 'pending' : status;
      delete step.finishedAt;
      if (status === 'queued') delete step.startedAt;
    }
    return record;
  };
  for (let group = 0; drafts.length < count; group++) {
    if (group % 3 !== 0) {
      drafts.push({ record: goLive(plainRun(rng, at()), group % 3 === 1 ? 'queued' : 'running') });
      continue;
    }
    const skillDriven = rng.chance(0.28);
    const rootId = rng.uuid();
    const workerIds = Array.from({ length: Math.min(2, count - drafts.length - 1) }, () => rng.uuid());
    drafts.push({ record: goLive(rootRun(rng, rootId, workerIds, at()), 'waiting') });
    for (const workerId of workerIds) {
      const draft = workerRun(rng, workerId, rootId, at());
      goLive(draft.record, 'running');
      const skill = rng.weighted(skillPrompts).text;
      draft.extraPrompt = rng.chance(0.1) ? text(rng, rng.logNormal(400, 2_000, 40, 4_000)) : undefined;
      if (skillDriven) draft.skillPrompt = skill;
      drafts.push(draft);
    }
  }
  return drafts;
}

function baseRun(rng: Rng, id: string, at: number, worker: boolean): RunRecord {
  const runner = rng.chance(0.8) ? 'claude' as const : 'codex' as const;
  const model = runner === 'claude' ? 'opus' : 'gpt-5.5';
  const roll = rng.next();
  const status = roll < 0.93 ? 'done' as const : roll < 0.98 ? 'cancelled' as const : 'failed' as const;
  const durationMs = rng.logNormal(12, 90, 1, 600) * MINUTE;
  const steps = worker ? 1 : rng.int(1, 2);
  const tokens = rng.int(10_000, 4_000_000);
  const record: RunRecord = {
    id,
    title: line(rng, rng.logNormal(70, 180, 12, 300)),
    workflow: 'quick-task',
    task: text(rng, rng.logNormal(500, 5_000, 30, 74_000)),
    model,
    modelIdentity: runner === 'claude' ? 'anthropic/claude-opus-5-5' : 'openai/gpt-5.5',
    runner,
    agentProfile: 'default',
    effort: 'high',
    generateFollowups: false,
    autonomous: rng.chance(0.3),
    status,
    createdAt: iso(at),
    startedAt: iso(at + 20_000),
    finishedAt: iso(at + durationMs),
    tokensUsed: tokens,
    inputTokens: Math.round(tokens * 0.9),
    outputTokens: Math.round(tokens * 0.1),
    costUsd: Math.round(tokens * 0.000_004 * 10_000) / 10_000,
    archived: false,
    steps: Array.from({ length: steps }, (_, index) => ({
      id: index === 0 ? 'task' : `continue-${index}`,
      name: index === 0 ? 'Do the task' : 'Continue',
      kind: 'agent' as const,
      status: status === 'failed' && index === steps - 1 ? 'failed' as const : 'done' as const,
      iterations: rng.int(1, 4),
      tokensUsed: Math.round(tokens / steps),
      inputTokens: Math.round((tokens / steps) * 0.9),
      outputTokens: Math.round((tokens / steps) * 0.1),
      usageInvocationEpoch: 1,
      usageInvocationsStarted: 1,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
      usageTurnsRecorded: 1,
      startedAt: iso(at + 20_000),
      finishedAt: iso(at + durationMs),
      sessionId: rng.uuid(),
      backend: runner,
      profileId: 'default',
      ...(index > 0 ? { synthetic: 'continuation' as const } : {}),
    })),
    workflowDef: {
      name: 'quick-task',
      description: 'One agent run on your task — no ceremony.',
      steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}', model, effort: 'high', runner, agentProfile: 'default',
        allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] }],
      source: 'built-in',
    },
  };
  if (status === 'failed') record.error = line(rng, rng.logNormal(120, 600, 20, 2_000));
  if (rng.chance(0.5)) { record.titleSummary = line(rng, rng.logNormal(45, 80, 10, 120)); record.titleOrigin = 'auto'; }
  if (rng.chance(0.7)) record.seenAt = iso(at + durationMs + 10 * MINUTE);
  if (rng.chance(0.3)) {
    const candidates = Array.from({ length: rng.int(1, 3) }, () => `${REPO}/issues/${rng.int(1, 999)}`);
    record.referencedIssueCandidates = candidates;
    record.referencedIssueUrl = candidates[0];
    record.issueNumber = Number(candidates[0]!.split('/').pop());
  }
  if (rng.chance(0.2)) {
    const pr = rng.int(1, 999);
    record.pullRequestUrl = `${REPO}/pull/${pr}`;
    record.prNumber = pr;
    record.referencedPrCandidates = [record.pullRequestUrl];
  }
  if (rng.chance(0.15)) record.markerRefs = { issue: rng.int(1, 999) };
  return record;
}

function plainRun(rng: Rng, at: number): RunRecord {
  const id = rng.uuid();
  return { ...baseRun(rng, id, at, false), ...worktree(rng, id) };
}

function worktree(rng: Rng, id: string) {
  return {
    worktreePath: `/home/dev/project/.ai/cezar/worktrees/${id}`,
    branch: `cez/${id.slice(0, 8)}`,
    baseBranch: 'main',
    diffStat: { adds: rng.int(0, 900), dels: rng.int(0, 400), files: rng.int(0, 40) },
  };
}

function rootRun(rng: Rng, id: string, workerIds: readonly string[], at: number): RunRecord {
  const record: RunRecord = { ...baseRun(rng, id, at, false), ...worktree(rng, id) };
  const observedAt = iso(at + 40 * MINUTE);
  const receipts = workerIds.map((workerId) => ({ requestId: rng.uuid(), workerId, requestHash: rng.hex(64) }));
  const delegation: Extract<NonNullable<RunRecord['delegation']>, { role: 'root' }> = {
    role: 'root',
    permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'],
    receipts,
  };
  if (workerIds.length > 0) {
    delegation.results = workerIds.filter(() => rng.chance(0.7)).map((workerId) => ({
      workerId, revision: 0, snapshotId: rng.uuid(), observedAt, lastExecutionOutcome: 'completed' as const,
    }));
    if (rng.chance(0.4)) {
      delegation.lastWait = {
        id: rng.uuid(), workerIds: [...workerIds], deadline: iso(at + 50 * MINUTE), mode: 'all', reason: 'outcome',
        phase: 'wake-pending',
        outcomes: workerIds.map((workerId) => ({ workerId, status: 'done' as const, observedAt, revision: 0 })),
      };
    }
    // The conversation is where root delegation's long tail lives.
    const target = rng.logNormal(4_500, 32_000, 600, 380_000);
    const messages: NonNullable<typeof delegation.conversation>['messages'] = [];
    const outcomes: NonNullable<typeof delegation.conversation>['outcomes'] = [];
    let bytes = 0;
    while (bytes < target && messages.length < 1_000) {
      const workerId = rng.pick(workerIds);
      const request = rng.uuid();
      const chars = rng.logNormal(500, 3_000, 20, 20_000);
      messages.push({ senderRunId: id, recipientRunId: workerId, kind: 'request', id: request, text: text(rng, chars),
        createdAt: observedAt, deadline: iso(at + 50 * MINUTE), requestHash: rng.hex(64), state: 'accepted' });
      bytes += chars + 450;
      if (rng.chance(0.6)) {
        const reply = rng.uuid();
        const replyChars = rng.logNormal(400, 2_500, 20, 20_000);
        messages.push({ senderRunId: workerId, recipientRunId: id, kind: 'reply', requestId: request, id: reply,
          text: text(rng, replyChars), createdAt: observedAt, requestHash: rng.hex(64), state: 'accepted' });
        outcomes.push({ requestId: request, status: 'replied', observedAt, replyId: reply });
        bytes += replyChars + 600;
      }
    }
    delegation.conversation = { messages, outcomes };
    if (rng.chance(0.35)) {
      record.agentInputs = agentInputs(rng, id, rng.pick(workerIds), id, 'reply', at);
    }
  }
  record.delegation = delegation;
  if (rng.chance(0.1)) record.lastCiWait = ciWait(rng, at);
  return record;
}

function workerRun(rng: Rng, id: string, parentId: string, at: number): Draft {
  const record = baseRun(rng, id, at, true);
  const delegation: Extract<NonNullable<RunRecord['delegation']>, { role: 'worker' }> = {
    role: 'worker',
    permissions: [],
    parentRunId: parentId,
    workspace: {
      ownerRunId: id, resourceId: rng.uuid(), kind: 'owned-isolated',
      path: `/home/dev/project/.ai/cezar/worktrees/${id}`, branch: `cez/${id.slice(0, 8)}`, baselineSha: rng.hex(40),
    },
    executionRevision: rng.int(0, 2),
    executionStartSeq: rng.int(0, 400),
  };
  if (rng.chance(0.4)) delegation.context = { text: text(rng, rng.logNormal(800, 6_000, 20, 60_000)), inputs: [] };
  record.delegation = delegation;
  if (rng.chance(0.5)) record.agentInputs = agentInputs(rng, parentId, parentId, id, 'request', at);
  return { record };
}

/** Inputs delivered to `recipient`, attributed to a conversation with `sender`. */
function agentInputs(rng: Rng, parentRunId: string, sender: string, recipient: string,
  kind: 'request' | 'reply', at: number): NonNullable<RunRecord['agentInputs']> {
  const target = rng.logNormal(3_000, 20_000, 400, 340_000);
  const inputs: NonNullable<RunRecord['agentInputs']> = [];
  let bytes = 0;
  while (bytes < target) {
    const chars = Math.min(100_000, Math.max(1, Math.min(target - bytes, rng.logNormal(1_500, 8_000, 20, 100_000))));
    const createdAt = iso(at + (inputs.length + 1) * MINUTE);
    inputs.push({
      conversation: { senderRunId: sender, recipientRunId: recipient, kind, ...(kind === 'reply' ? { requestId: rng.uuid() } : {}) },
      id: rng.uuid(), source: 'agent', parentRunId, text: text(rng, chars), createdAt, deliveredAt: createdAt, consumedAt: createdAt,
    });
    bytes += chars + 420;
  }
  return inputs;
}

function ciWait(rng: Rng, at: number): NonNullable<RunRecord['lastCiWait']> {
  const pr = rng.int(1, 999);
  const headSha = rng.hex(40);
  const id = rng.uuid();
  return {
    prUrl: `${REPO}/pull/${pr}`, repository: 'example-org/example-repo', prNumber: pr, headSha, id,
    generation: rng.uuid(), turnId: rng.uuid(), timeoutSeconds: 1_800,
    registeredAt: iso(at + 30 * MINUTE), deadline: iso(at + 60 * MINUTE), phase: 'delivered',
    result: {
      outcome: 'passed', headSha, observedAt: iso(at + 45 * MINUTE), totalChecks: 21, truncated: false,
      checks: Array.from({ length: 21 }, (_, index) => ({
        name: `check-${index + 1} (ubuntu-latest)`, state: 'SUCCESS',
        link: `${REPO}/actions/runs/${rng.int(1e10, 9e10)}/job/${rng.int(1e10, 9e10)}`,
      })),
    },
    wakeId: id, deliveredAt: iso(at + 46 * MINUTE),
  };
}
