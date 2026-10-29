import { existsSync } from 'node:fs';
import { loadConfig } from '../../config.ts';
import { worktreeShortstat } from '../../git-worktree.ts';
import { autoNamingActive, generateRunName, liveTitleUpdatesEnabled, postValidateTitle } from '../../runs/auto-name.ts';
import { extractTaskRefs } from '../../runs/task-refs.ts';
import { parseTaskMarkers } from '../../runs/task-markers.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { Skill } from '../../skills.ts';
import { stepKind, type WorkflowDef } from '../types.ts';
import type { RunModuleContext } from './types.ts';

interface TurnBookkeeperHost {
  isDisposedDelegatedRun(runId: string): boolean;
  discoverSkills(): Promise<Skill[]>;
  reviveWorkflow(run: RunRecord): Promise<WorkflowDef | null>;
  autoNameRun(runId: string, skillName: string | undefined, task: string, live?: { turnText?: string; diffStat?: string | undefined }): Promise<void>;
}

export class TurnBookkeeper {
  /** Last live-refresh namer inputs per run — unchanged inputs skip the call. */
  readonly lastNamerKey = new Map<string, string>();
  constructor(private readonly context: RunModuleContext, private readonly host: TurnBookkeeperHost) {}

  forget(runId: string): void { this.lastNamerKey.delete(runId); }
  clear(): void { this.lastNamerKey.clear(); }

  /**
   * The namer's apply path (task auto-naming spec). Fire-and-forget: called
   * without await from `startRun` (creation) and `recordTurnEnd` (live
   * refresh). A user-owned title (`titleOrigin: 'user'`) is never overwritten;
   * namer-owned titles may be replaced by fresher namer results.
   */
  async autoNameRun(
    runId: string,
    skillName: string | undefined,
    task: string,
    live?: { turnText?: string; diffStat?: string | undefined },
  ): Promise<void> {
    // CEZ_AUTONAME=0 kills all LLM naming; dry-run skips it too unless
    // CEZ_AUTONAME=1 forces the mock path — see autoNamingActive.
    if (!autoNamingActive()) return;
    try {
      let skillDescription: string | undefined;
      if (skillName) {
        const skills = await this.host.discoverSkills().catch(() => [] as Skill[]);
        skillDescription = skills.find((s) => s.name === skillName)?.description;
      }
      const result = await generateRunName(this.context.repoRoot, { task, skillName, skillDescription, ...live });
      if (!result || this.host.isDisposedDelegatedRun(runId)) return;
      const run = this.context.store.getRun(runId);
      // Marker-owned state outranks the namer (spec 2026-07-18-task-ref-markers):
      // a declared title blocks the whole apply (this call raced the marker),
      // and a declared pr/issue kind blocks that kind field-by-field.
      if (!run || run.titleOrigin === 'user' || run.titleOrigin === 'marker') return;
      this.context.store.updateRun(runId, {
        titleSummary: result.titleSummary,
        titleOrigin: 'auto',
        ...(result.prNumber !== undefined && run.markerRefs?.pr === undefined
          ? { prNumber: result.prNumber }
          : {}),
        ...(result.issueNumber !== undefined && run.markerRefs?.issue === undefined
          ? { issueNumber: result.issueNumber }
          : {}),
      });
    } catch {
      // Naming is best-effort — nothing here may disturb the run.
    }
  }

  /**
   * Turn-end bookkeeping (open-mercato/cezar#389), shared by `runAgentStep` and
   * `runContinuation` — called (fire-and-forget) from every `turn-end` event:
   *
   *  - `titleSummary`: derived from the turn's text, set ONCE — only while the
   *    record has none. A user's inline edit also lands in `titleSummary`
   *    (see `PATCH /api/runs/:id`), so an edit is never overwritten either.
   *  - `diffStat`: cheap `git diff --shortstat` vs the base, refreshed every
   *    turn. Async and best-effort — a git failure becomes at most a `note`
   *    event, NEVER a run failure. `updateRun` fans the record out over SSE,
   *    so the list views pick both up with no extra wiring.
   *
   * Not `private` so the integration tests can drive a turn-end directly —
   * a real agent session is the only other way to reach this path.
   */
  async recordTurnEnd(runId: string, turnText: string): Promise<void> {
    if (this.host.isDisposedDelegatedRun(runId)) return;
    try {
      const run = this.context.store.getRun(runId);
      if (!run) return;
      this.applyTurnMarkers(runId, run, turnText);
      // Titles are the namer's job (task auto-naming spec) — turn text is
      // deliberately NEVER a title source; see maybeRefreshTitle below. The
      // one exception is an explicit CEZ:TITLE declaration (applied above).
      if (run.worktreePath && existsSync(run.worktreePath)) {
        // `taskBranch` + `runStartedAt` are what keep this number *this task's* (open-mercato/cezar#751): a
        // review/QA run repoints the worktree onto the branch under review, and without the
        // branch to compare HEAD against and the moment it was checked out, the stat would
        // claim that whole branch's diff.
        const stat = await worktreeShortstat(run.worktreePath, run.baseBranch ?? 'HEAD', {
          taskBranch: run.branch,
          runStartedAt: run.startedAt,
        });
        if (this.host.isDisposedDelegatedRun(runId)) return;
        if (stat) this.context.store.updateRun(runId, { diffStat: stat });
        else this.context.store.appendEvent(runId, { type: 'note', message: 'diff stat unavailable — git diff --shortstat failed in the worktree' });
      }
      await this.maybeRefreshTitle(runId, turnText);
    } catch {
      // Bookkeeping only — nothing here may disturb the run.
    }
  }

  /**
   * In-band declarations from the finished turn (spec
   * 2026-07-18-task-ref-markers): the main thread's own `CEZ:PR=` /
   * `CEZ:ISSUE=` / `CEZ:TITLE=` lines, parsed from the accumulated turn text
   * like `CEZ:DONE` — never from tool output. Declared numbers overwrite the
   * regex/namer display tier (the store re-resolves the referenced-PR chip);
   * a declared title takes `titleOrigin: 'marker'`, which beats the namer but
   * never a user rename, and silences the live refresh below.
   */
  private applyTurnMarkers(runId: string, run: RunRecord, turnText: string): void {
    const markers = parseTaskMarkers(turnText);
    if (markers.pr !== undefined || markers.issue !== undefined) {
      this.context.store.applyMarkerRefs(runId, { pr: markers.pr, prs: markers.prs, issue: markers.issue });
    }
    if (markers.title && run.titleOrigin !== 'user') {
      const current = this.context.store.getRun(runId);
      const promptRefs = extractTaskRefs(run.task);
      const promptIssue = promptRefs.issueNumber ?? (promptRefs.prNumber === undefined ? promptRefs.ambiguousNumber : undefined);
      const refNumber = promptRefs.prNumber === undefined && promptIssue !== undefined && promptIssue === current?.issueNumber
        ? current.issueNumber : current?.prNumber ?? current?.issueNumber;
      const validated = postValidateTitle(markers.title, refNumber);
      // Same junk guard as composeNameResult: a declaration that validates to
      // nothing (or to a bare number prefix) must not blank the title.
      if (validated && validated !== `${refNumber}:`) {
        this.context.store.updateRun(runId, { titleSummary: validated, titleOrigin: 'marker' });
      }
    }
  }

  /**
   * Live title refresh (task auto-naming spec, step 3): re-run the namer with
   * the turn's context. Skips: toggle off (`liveTitleUpdates` config over
   * `CEZ_TITLE_UPDATES` env, default ON), user-owned title, marker-owned title
   * (the agent declares via `CEZ:TITLE` — the token-saving fast path), dry-run
   * mocks (canned answers add nothing), empty turn text, unchanged namer inputs.
   */
  async maybeRefreshTitle(runId: string, turnText: string): Promise<void> {
    if (!autoNamingActive()) return;
    if (!turnText.trim()) return;
    const config = await loadConfig(this.context.repoRoot);
    if (!liveTitleUpdatesEnabled(config)) return;
    const run = this.context.store.getRun(runId);
    if (!run || run.titleOrigin === 'user' || run.titleOrigin === 'marker') return;
    const statText = run.diffStat ? `${run.diffStat.files} files, +${run.diffStat.adds} -${run.diffStat.dels}` : undefined;
    const key = `${turnText.slice(0, 200)}|${statText ?? ''}`;
    if (this.lastNamerKey.get(runId) === key) return;
    this.lastNamerKey.set(runId, key);
    const workflow = await this.host.reviveWorkflow(run);
    const skillName = workflow?.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    void this.host.autoNameRun(runId, skillName, run.task, { turnText, diffStat: statText });
  }

}
