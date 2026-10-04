import { deriveAttention, type ApiRun, type AttentionBucket, type RunStatus } from '@open-mercato/cezar-contract';

/**
 * The slim shapes `cez task` prints (#504). A bot polls these every few seconds, so each one
 * carries what a caller branches on and nothing it would have to pay tokens to skip: no
 * `steps[]`, no `workflowDef`, no reference candidates. `--full` is the escape hatch.
 *
 * Both default shapes carry `attention` + `attentionLabel` (#553/#609): the cockpit's own answer
 * to "does this run want a human", from the contract's `deriveAttention`, so a bot never has to
 * learn cezar's status vocabulary to decide whether to act. `waiting` is attention even when
 * `hasPendingHumanAsk` is false; `running` + `activity: monitoring` is neither settled nor
 * attention. `--full` prints the contract `ApiRun` untouched — the derived fields are not on it.
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

export interface AttentionFields {
  /** The cockpit's attention bucket: `waiting`/`error`/`permission` want a human; `running` and `none` do not. */
  attention: AttentionBucket;
  /** The cockpit's lower-case phrase: "needs you", "needs review", "monitoring", "waiting on 2 workers"… */
  attentionLabel: string;
}

/** The two derived fields, from the same function the cockpit's Needs You reads. */
export function attentionFields(run: Parameters<typeof deriveAttention>[0]): AttentionFields {
  const attention = deriveAttention(run);
  return { attention: attention.bucket, attentionLabel: attention.label };
}

export function projectStatus(run: ApiRun, url: string, question?: unknown) {
  return defined({
    id: run.id,
    title: runTitle(run),
    status: run.status,
    activity: run.activity,
    ...attentionFields(run),
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

/** First line only, with the ellipsis inside the 200-character budget whenever text is cut. */
function listError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  const firstLine = error.split(/[\r\n]/, 1)[0]!;
  return firstLine.length < error.length || firstLine.length > 200
    ? `${firstLine.slice(0, 199)}…`
    : firstLine;
}

/** The record carries no `updatedAt`; the newest lifecycle stamp is the honest stand-in. */
export function projectListRow(run: ApiRun) {
  return defined({
    id: run.id,
    title: runTitle(run),
    status: run.status,
    activity: run.activity,
    ...attentionFields(run),
    hasPendingHumanAsk: run.hasPendingHumanAsk ?? false,
    // One next-action datum per status; details such as branch/diff/tokens stay on status.
    currentStepId: run.status === 'running' ? run.currentStepId : undefined,
    pullRequestUrl: SUCCESS_STATUSES.includes(run.status) ? run.pullRequestUrl : undefined,
    error: run.status === 'failed' ? listError(run.error) : undefined,
    updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
  });
}
