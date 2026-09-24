import type { ApiRun, RunStatus } from '@open-mercato/cezar-contract';

/**
 * The slim shapes `cez task` prints (#504). A bot polls these every few seconds, so each one
 * carries what a caller branches on and nothing it would have to pay tokens to skip: no
 * `steps[]`, no `workflowDef`, no reference candidates. `--full` is the escape hatch.
 */

export const TERMINAL_STATUSES: readonly RunStatus[] = ['done', 'review', 'failed', 'cancelled'];
export const SUCCESS_STATUSES: readonly RunStatus[] = ['done', 'review'];

/** Keys with an undefined value are left off, so the JSON stays as small as the run is. */
function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function runTitle(run: Pick<ApiRun, 'title' | 'titleSummary'>): string {
  return run.titleSummary ?? run.title;
}

export function projectStatus(run: ApiRun, url: string, question?: unknown) {
  return defined({
    id: run.id,
    title: runTitle(run),
    status: run.status,
    activity: run.activity,
    currentStepId: run.currentStepId,
    hasPendingHumanAsk: run.hasPendingHumanAsk ?? false,
    question,
    branch: run.branch,
    diffStat: run.diffStat,
    pullRequestUrl: run.pullRequestUrl,
    error: run.error,
    tokensUsed: run.tokensUsed,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    url,
  });
}

/** The record carries no `updatedAt`; the newest lifecycle stamp is the honest stand-in. */
export function projectListRow(run: ApiRun) {
  return defined({
    id: run.id,
    title: runTitle(run),
    status: run.status,
    activity: run.activity,
    hasPendingHumanAsk: run.hasPendingHumanAsk ?? false,
    updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
  });
}
