import './session-layout.css'
import { deriveAttention } from '@/lib/attention'
import { MessageSquareTextIcon, SearchXIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useLocation, useParams } from 'react-router'

import { Link, useActiveProjectId } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import {
  useEditQueuedMessage,
  useMarkRunSeen,
  usePatchRun,
  useRemoveQueuedMessage,
  useRun,
  useProjectRepoBase,
  useRuns,
  useRunRelationships,
  useSendMessage,
} from '@/api/queries'
import { useRunHistory, type RunHistoryState } from '@/api/run-history'
import { pendingHumanAsk } from '@open-mercato/cezar-api-client/contract/ask'
import { asksQuestion } from '@open-mercato/cezar-api-client/contract/waits'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Composer, type ComposerHandle } from '@/components/composer/composer'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { useKeyboardInsetVar } from '@/lib/keyboard-inset'
import { isUnread } from '@/lib/read-state'
import { useVoiceProposal, voiceStore } from '@/lib/voice/proposal-store'
import { taskIssueUrl, taskPrUrl } from '@/lib/tasks-table'
import { cn, isHttpUrl } from '@/lib/utils'

import { AutoResumeHint } from './auto-resume-hint'
import { WorkingIndicator } from './thread-items'
import { useContinueAction } from './follow-up-engine'
import { findSubagent, subagentChildren } from './subagent-dock'
import { SubagentSheet } from './subagent-sheet'
import { AcceptCelebration, ReviewPanel } from './review-panel'
import { archiveInComposer, isSessionOpen, offersComposerFinish, queuePosition, runActionFlags } from './run-actions'
import { ArchiveButton } from './archive-action'
import { useFinishRun } from './use-finish-run'
import { useStopAction } from './stop-action'
import { RunHeader } from './run-header'
import { RunActivityDock } from './run-activity-dock'
import { AskCard, AskContext } from './ask-card'
import { PermissionCard } from './permission-card'
import { useAskAnswer } from './ask-answer'
import { useRunRecordReconcile } from './run-reconcile'
import { useActiveProviderAvailability } from './active-provider'
import { ThreadLoading } from './thread-loading'
import { threadRenderMode } from './thread-scroll'
import { JumpToLatestPill, useThreadScroll, type ThreadScrollControls } from './thread-scroller'
import { AskOriginMarker, pinnedAnswerControl, pinnedAskFocus } from './pending-ask-navigation'
import { useRevealAskOrigin } from './use-reveal-ask-origin'
import { useSessionViewport } from './session-viewport'
import {
  PENDING_ASK_SECTION_ID,
  SessionTranscript,
  askRow,
  buildTranscriptRows,
  mainTranscriptSections,
  type TranscriptMessageActions,
} from './session-transcript'
import { recipientBackendsFromRuns, titlesFromRuns } from './conversation-presentation'
import {
  reduceThread,
  threadFilePaths,
  threadFooter,
  type ThreadAsk,
  type ThreadPermission,
  type ThreadState,
} from './thread-state'

/**
 * `/tasks/:id` — the Session tab (spec, "Task thread"): the run header (title/meta/tabs/
 * actions — see run-header.tsx), turns with user bubbles, assistant markdown, tool cards,
 * dim lifecycle lines, the closed footer, and the docked composer (plan dock · paused hint ·
 * reply box).
 *
 * Data doctrine: `useRun` is authoritative for the record; `useRunHistory` hydrates a bounded
 * visible transcript plus compact current-state context and falls back to `useRunEvents` when
 * the optimized route is unavailable. The rendered rows go through the threshold-switched scroller
 * (thread-scroller.tsx — flat + content-visibility below ~300 rows, virtua above).
 */
export function TaskThreadRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  const history = useRunHistory(id)
  const runStatus = run.data?.status
  const thread = useMemo(
    () => reduceThread(history.visibleEvents, { activeTurn: runStatus === 'running' }),
    [history.visibleEvents, runStatus],
  )
  const currentThread = useMemo(
    () => reduceThread(history.currentEvents, { activeTurn: runStatus === 'running' }),
    [history.currentEvents, runStatus],
  )

  // Read receipt (#unread-done-items): opening a finished task's thread marks it read — the same
  // "opening the mail clears the unread dot" move. Gated on `isUnread` so it fires only for a
  // genuinely-unread done item, and keyed on the record's read-relevant fields so it converges:
  // the optimistic `seenAt` flips `isUnread` false and the effect does not re-fire. A run that
  // later resumes and re-finishes (its `finishedAt` moves past the receipt) marks read again.
  //
  // The one exception is "Mark unread" from this very thread (#775): clearing the receipt makes
  // `isUnread` true again, which without a guard this effect would immediately undo — the action
  // would look broken in exactly the place a user reaches for it. `suppressAutoRead` is that
  // guard, and it holds the run id rather than a bare boolean so the reset is implicit: it only
  // suppresses the run it was set for, and the FIRST render of a later visit (a fresh mount, or
  // navigating to another task and back) starts from an empty ref and auto-reads normally. That
  // is the email grammar this is modelled on — reopening the mail marks it read again.
  const suppressAutoRead = useRef<string | undefined>(undefined)
  const suppressAutoReadFor = useCallback((runId: string) => {
    suppressAutoRead.current = runId
  }, [])
  const { mutate: markRunSeen } = useMarkRunSeen()
  useEffect(() => {
    if (!run.data) return
    if (suppressAutoRead.current === run.data.id) return
    if (isUnread(run.data)) markRunSeen(run.data.id)
  }, [
    markRunSeen,
    run.data?.id,
    run.data?.status,
    run.data?.finishedAt,
    run.data?.seenAt,
    // `isUnread` reads `archived` too, so it belongs here: un-archiving an open thread makes the
    // run unread again, and without this dep the effect would never fire to clear it.
    run.data?.archived,
  ])
  // The two feeds can drift: a record update lost on the workspace stream leaves the thread
  // showing Working… over a "run finished" transcript. The transcript is live here, so it
  // arbitrates — a session end with no session after it refetches a record still claiming one.
  useRunRecordReconcile(run.data, history.visibleEvents)

  if (run.isPending) return <ThreadLoading />

  if (run.isError) {
    const notFound = run.error instanceof ApiError && run.error.status === 404
    return (
      <div data-route="task-thread" className="flex min-h-full flex-col">
        <CenteredState
          icon={notFound ? <SearchXIcon /> : <MessageSquareTextIcon />}
          tone={notFound ? 'neutral' : 'danger'}
          title={notFound ? 'Task not found' : 'Could not load this task'}
          subtitle={
            notFound
              ? 'No run has this id. It may have been deleted, or the link is from another machine.'
              : run.error.message
          }
          actions={
            <Button asChild variant="outline">
              <Link to="/">Back to tasks</Link>
            </Button>
          }
        />
      </div>
    )
  }

  if (history.isPending) return <ThreadLoading />

  return (
    <ThreadView
      run={run.data}
      thread={thread}
      currentThread={currentThread}
      history={history}
      onMarkedUnread={suppressAutoReadFor}
    />
  )
}

/** The loaded thread. The header owns its own data hooks (mutations, the runs list); the
 *  thread body stays presentational — tests drive it with reduced fixture states directly. */
export function ThreadView({
  run,
  thread,
  currentThread = thread,
  history,
  onMarkedUnread,
}: {
  run: ApiRun
  thread: ThreadState
  currentThread?: ThreadState
  history?: RunHistoryState
  /** Passed straight through to the header's "Mark unread" (#775) so the route can suppress its
   *  auto-mark-read effect. Optional: every test that drives this view with a fixture, and the
   *  header's other three tabs, have no such effect to suppress. */
  onMarkedUnread?: (runId: string) => void
}) {
  const projectId = useActiveProjectId()
  const runs = useRuns()
  // A voice "tell it" proposal fills this composer's draft (spec 2026-10-21-voice-mode). The
  // store reaches the composer through its handle, registered for this run while it is mounted.
  const composerRef = useRef<ComposerHandle>(null)
  const voiceProposal = useVoiceProposal()
  const tellProposed = voiceProposal?.kind === 'tell' && voiceProposal.runId === run.id
  useEffect(
    () =>
      voiceStore.registerComposer({
        runId: run.id,
        getDraft: () => composerRef.current?.getDraft() ?? '',
        setDraft: (text) => composerRef.current?.setDraft(text) ?? false,
        // A composer that is already gone holds no draft.
        clearVoiceDraft: (text) => composerRef.current?.clearVoiceDraft(text) ?? true,
        submit: () => composerRef.current?.submit() ?? false,
      }),
    [run.id],
  )
  // Attention reads the open human wait on the record; the transcript's unanswered ask only
  // decides whether the composer answers it (hearsay-tools/cezarion#1236, split by fact).
  const { pendingAsk, transcriptAsk, pendingAskId, historyLoading } = pendingThreadAsk(history, currentThread)
  useEffect(() => {
    if (!historyLoading) voiceStore.syncPendingAsk(run.id, pendingAskId)
  }, [run.id, pendingAskId, historyLoading])
  useEffect(() => () => voiceStore.leaveTask(run.id), [run.id])
  const attention = deriveAttention(run)
  const footer = threadFooter(run.status, run.error)
  // The Agents dock's data: the current fan-out's sub-agents, or [] when there is none to
  // show (#474). Derived from the same reduced turns the thread renders — no new subscription.
  // The legacy session-open rule (web/app.js `updateDetail`): the composer can deliver while
  // the engine owns a live session — running queues the message, waiting answers it.
  // A usage-limit hold is `waiting` with no session until its resume (hearsay-tools/cezarion#1236).
  const sessionOpen = isSessionOpen(run)
  // Closed runs keep their in-flight sub-agent cards as historical rows.
  const runIsTerminal = !sessionOpen && run.status !== 'queued'
  // Queued sends amend the original prompt; they do not open a provider session.
  const queued = run.status === 'queued'
  // …and the fourth: a closed run whose last session can be reopened. Continue used to be a
  // bare button beside a DISABLED textarea, so "reopen it and say what to do next" meant
  // continuing blind and then typing into the thread once the session came back. The composer
  // stays authorable here instead: the draft is the prompt the reopened session starts on, and
  // submitting an empty one is still the plain one-click Continue.
  const continueAction = useContinueAction(run)
  const stopAction = useStopAction(run)
  // Finish as the composer's gold primary on a Needs-you task (#281). The rule lives in
  // run-actions.ts with the rest of the action policy; the mutation is the shared one the header
  // and the review panel's ✓ Accept already drive, so "finish" can never fork into three
  // meanings. A rejection is already a danger toast from inside the hook — swallowed here so the
  // click handler does not also surface it as an unhandled rejection.
  const finishAction = useFinishRun(run.id)
  // Cezar's own waits ask nothing, so they leave empty Continue available (review of #1437).
  const needsAnswer = transcriptAsk || asksQuestion(run)
  const { hasContinuation, continuable } = threadContinuation(sessionOpen, queued, continueAction)
  // A closed session can never settle its in-flight items — nothing in the reducer rewrites a
  // `running` item on `session.ended`, so an interrupted fan-out stays `running` in the
  // persisted stream forever. Without this, reopening it pulses `Agents · 0/1` above a dead
  // transcript for good.
  //
  // Derived from `sessionOpen` rather than enumerated, so it cannot drift when a status is
  // added: anything that is neither live nor still queued is closed. `review` matters most —
  // it is where this pipeline's runs normally END, and `threadFooter` already calls it closed.
  // The drill-down's whole state: which agent is open. Ephemeral by design (spec Q2/Q5) —
  // sub-agents have no stable identity outside their run, so there is nothing to persist.
  const [openAgentId, setOpenAgentId] = useState<string | undefined>(undefined)
  // Item ids repeat across runs (codex mints `item_1`, `item_rv_1` per session), so a
  // selection carried across a route change could pop the sheet open on an unrelated item.
  const [selectionRunId, setSelectionRunId] = useState(run.id)
  if (selectionRunId !== run.id) {
    setSelectionRunId(run.id)
    setOpenAgentId(undefined)
  }
  // Resolved from the turns, NOT from `agents`: the dock can yield to the transcript (Q6)
  // while a sheet is open, and that must not slam the panel shut mid-read.
  const openAgent = useMemo(
    () =>
      openAgentId === undefined ?
        undefined
      : findSubagent(currentThread.turns, openAgentId, runIsTerminal),
    [currentThread.turns, openAgentId, runIsTerminal],
  )
  const openAgentChildren = useMemo(
    () => (openAgentId === undefined ? [] : subagentChildren(currentThread.turns, openAgentId)),
    [currentThread.turns, openAgentId],
  )
  const sendMessage = useSendMessage(run.id)
  const reply = useAskAnswer(run)
  const activeProvider = useActiveProviderAvailability(run)
  // A queued send only amends the persisted prompt; it invokes no provider and therefore
  // remains available even when provider discovery cannot authorize a live session. Once the
  // session is open, mirror the server's active-backend gate as before.
  const { providerBlocked, providerReason } = threadProviderState(sessionOpen, activeProvider, hasContinuation, continueAction)

  // The queued-run affordances (#472), passed only while the run is queued — so the bubbles
  // go read-only on the next `run` SSE frame once it starts. The bubbles await these promises
  // so a failed write keeps its editor/draft open and shows the server's error.
  // Depend on the `mutateAsync` functions, NOT the mutation result objects: TanStack returns a
  // fresh result object every render, so memoizing on those would rebuild `edit` — and with it
  // every thread row — on each render, defeating the memo that exists because these threads get
  // big enough to virtualize. `mutateAsync` is referentially stable.
  const { mutateAsync: patchRunAsync } = usePatchRun(run.id)
  const { mutateAsync: editQueuedAsync } = useEditQueuedMessage(run.id)
  const { mutateAsync: removeQueuedAsync } = useRemoveQueuedMessage(run.id)
  const edit = useMemo(
    () =>
      queued ?
        {
          onEditTask: async (text: string) => { await patchRunAsync({ task: text }) },
          onEditMessage: (msgId: string, text: string) =>
            editQueuedAsync({ msgId, message: { text } }).then(() => undefined),
          onRemoveMessage: (msgId: string) => removeQueuedAsync(msgId).then(() => undefined),
        }
      : undefined,
    [queued, patchRunAsync, editQueuedAsync, removeQueuedAsync],
  )

  // Current state is authoritative once its context has loaded: `null` then says no ask is
  // pending, so an unresolved ask left in an older page renders as answered (#1495).
  const sectionsAskId = historyLoading ? undefined : (pendingAskId ?? null)
  const sections = useMemo(() => mainTranscriptSections(run, thread, currentThread, sectionsAskId), [run, thread, currentThread, sectionsAskId])
  const rows = useMemo(() => buildTranscriptRows(sections, run.id), [sections, run.id])
  // A delegated run's conversation names its parent and workers; once archived they may be past
  // the run list's window (#864), so the relationships answer carries their titles too. The same
  // cache entry the Workers section reads.
  const delegated = run.delegation?.role === 'root' || run.delegation?.role === 'worker'
  const relationships = useRunRelationships(run.id, { enabled: delegated })
  const taskTitles = useMemo(() => titlesFromRuns(run, runs.data, relationships.data?.titles), [run, runs.data, relationships.data])
  const recipientBackends = useMemo(() => recipientBackendsFromRuns(run, runs.data), [run, runs.data])
  const renderPermission = useCallback((permission: ThreadPermission) => <PermissionCard permission={permission} runId={run.id} sessionOpen={sessionOpen} />, [run.id, sessionOpen])
  const messageActions = useMemo<Readonly<Record<string, TranscriptMessageActions>> | undefined>(() => {
    if (edit === undefined) return undefined
    const actions: Record<string, TranscriptMessageActions> = {
      task: { onEdit: edit.onEditTask, editLabel: 'Edit the prompt' },
    }
    for (const message of run.queuedMessages ?? []) {
      actions[`queued:${message.id}`] = {
        onEdit: (text) => edit.onEditMessage(message.id, text),
        onRemove: () => edit.onRemoveMessage(message.id),
      }
    }
    return actions
  }, [edit, run.queuedMessages])
  // #526: the footer's issue link may be synthesized from the CEZ:ISSUE marker, and the only
  // repository it may ever name is the one on screen — never the transcript's.
  const issueUrl = taskIssueUrl(run, useProjectRepoBase())
  const { search } = useLocation()
  const mode = threadRenderMode(search, rows.length)
  const scroll = useThreadScroll(`${run.id}:main`, {
    onLoadOlder: history?.hasOlder ? history.loadOlder : undefined,
    onJumpToLatest: history?.jumpToLatest,
    rowKeys: rows.map(({ key }) => key),
  })
  // The pending question (hearsay-tools/cezarion#1495): pinned after the newest entry, with a
  // marker where it was asked. Rows and jumps go through refs so the card renderer stays stable.
  const { pinnedAsk, pendingQuestions } = pinnedThreadAsk(sections)
  const revealOrigin = useRevealAskOrigin({
    pendingAskId,
    askSeq: history ? pendingAsk?.seq : undefined,
    rows,
    history,
    jumpToRow: scroll.jumpToRow,
  })
  // The pill's late focus reads this to give up once its question was answered. A history
  // reload has no answer yet, so it keeps the last settled id.
  const settledAskIdRef = useRef(pendingAskId)
  if (!historyLoading) settledAskIdRef.current = pendingAskId
  const navigationRef = useRef({ rows, jumpToRow: scroll.jumpToRow, reveal: revealOrigin.reveal })
  navigationRef.current = { rows, jumpToRow: scroll.jumpToRow, reveal: revealOrigin.reveal }
  const renderAsk = useCallback((ask: ThreadAsk) => {
    if (ask.placement === 'origin') {
      const goToQuestion = () => {
        const { rows: current, jumpToRow } = navigationRef.current
        const pinned = askRow(current, ask.id, 'pinned')
        if (pinned) jumpToRow(pinned.key, pinned.index, (row) => pinnedAnswerControl(row))
      }
      return <div className="flex flex-col gap-3">
        {ask.resolved && ask.context ? <AskContext text={ask.context} /> : null}
        {!ask.resolved ? <AskOriginMarker onGoToQuestion={goToQuestion} /> : null}
      </div>
    }
    return <AskCard ask={ask} run={run} onShowOrigin={() => navigationRef.current.reveal()} />
  }, [run])
  // Re-pin a tail reader after the viewport or document-flow composer changes size.
  useKeyboardInsetVar(scroll.restickIfStuck)
  const viewportRef = useSessionViewport()
  return (
    <div ref={viewportRef} data-route="task-thread" data-run-id={run.id} className="flex min-h-full flex-col">
      <RunHeader run={run} onMarkedUnread={() => onMarkedUnread?.(run.id)} />

      <ThreadTranscript
        run={run}
        thread={thread}
        history={history}
        footer={footer}
        issueUrl={issueUrl}
        sections={sections}
        renderAsk={renderAsk}
        renderPermission={renderPermission}
        messageActions={messageActions}
        scroll={scroll}
        mode={mode}
        taskTitles={taskTitles}
        recipientBackends={recipientBackends}
      />

      <AcceptCelebration status={run.status} />

      {/* The drill-down for whichever Agents-dock row was clicked. Rendered outside the dock
          so the sheet's portal is not affected by the dock's collapse state. SessionTranscript
          owns the shared run-keyed card cache, so expanded sheet cards survive a reopen. */}
      <SubagentSheet
        runId={run.id}
        renderAsk={renderAsk}
        renderPermission={renderPermission}
        agent={openAgent}
        entries={openAgentChildren}
        taskTitles={taskTitles}
        recipientBackends={recipientBackends}
        onClose={() => setOpenAgentId(undefined)}
      />

      <ThreadFooterDock
        run={run}
        thread={thread}
        currentThread={currentThread}
        scroll={scroll}
        pendingQuestions={pendingQuestions}
        onJump={() => {
          const askId = pendingQuestions > 0 ? pinnedAsk?.id : undefined
          scroll.jumpToLatest(askId === undefined ? undefined : pinnedAskFocus(askId, () => settledAskIdRef.current === askId))
        }}
        onOpenWorker={setOpenAgentId}
        sessionOpen={sessionOpen}
        attention={attention}
        queued={queued}
        continuable={continuable}
        continueAction={continueAction}
        composerRef={composerRef}
        tellProposed={tellProposed}
        stopAction={stopAction}
        finishAction={finishAction}
        needsAnswer={needsAnswer}
        sendMessage={sendMessage}
        reply={reply}
        providerBlocked={providerBlocked}
        providerReason={providerReason}
      />

      {/* The sole mobile scroll anchor sits after every region whose height can change. Keeping
          this tail pixel in place makes streamed rows and composer growth settle in the same
          layout pass: the textarea grows upward while the dock's bottom stays put. */}
      <div data-slot="thread-tail-anchor" aria-hidden="true" className="h-px shrink-0 md:hidden" />
    </div>
  )
}

/** Compact current-state context is authoritative while history pages may contain old asks. */
function pendingThreadAsk(history: RunHistoryState | undefined, currentThread: ThreadState) {
  const pendingAsk = history ? pendingHumanAsk(history.currentEvents) : undefined
  const transcriptAsk = history
    ? pendingAsk !== undefined
    : currentThread.turns.some(turn => turn.items.some(item => item.kind === 'ask' && !item.resolved))
  // A voice answer proposal outlives its card (a virtualized row unmounts while the question is
  // open), so the thread says when the question itself settled or the user left the task. The
  // id comes from the transcript, the same source the ask card renders from.
  const pendingAskId = history
    ? (typeof pendingAsk?.requestId === 'string' ? pendingAsk.requestId : undefined)
    : currentThread.turns.flatMap(turn => turn.items).reverse().find(item => item.kind === 'ask' && !item.resolved)?.id
  const historyLoading = history !== undefined && (history.isPending || history.contextPending)
  return { pendingAsk, transcriptAsk, pendingAskId, historyLoading }
}

function threadContinuation(
  sessionOpen: boolean,
  queued: boolean,
  continueAction: ReturnType<typeof useContinueAction>,
) {
  const hasContinuation = !sessionOpen && !queued && continueAction.available
  const continuable = hasContinuation && continueAction.canContinue
  return { hasContinuation, continuable }
}

function threadProviderState(
  sessionOpen: boolean,
  activeProvider: ReturnType<typeof useActiveProviderAvailability>,
  hasContinuation: boolean,
  continueAction: ReturnType<typeof useContinueAction>,
) {
  const activeProviderBlocked = sessionOpen && !activeProvider.usable
  const continuationProviderBlocked = hasContinuation && !continueAction.canContinue
  const providerBlocked = activeProviderBlocked || continuationProviderBlocked
  const providerReason = activeProviderBlocked ? activeProvider.reason : continueAction.reason
  return { providerBlocked, providerReason }
}

function pinnedThreadAsk(sections: ReturnType<typeof mainTranscriptSections>) {
  const pinnedSection = sections.at(-1)
  const pinnedAsk = pinnedSection?.id === PENDING_ASK_SECTION_ID ? pinnedSection.entries[0] : undefined
  const pendingQuestions = pinnedAsk?.kind === 'ask' ? pinnedAsk.questions.length : 0
  return { pinnedAsk, pendingQuestions }
}

type ThreadTranscriptProps = {
  sections: ReturnType<typeof mainTranscriptSections>
  renderAsk: (ask: ThreadAsk) => ReactNode
  renderPermission: (permission: ThreadPermission) => ReactNode
  messageActions: Readonly<Record<string, TranscriptMessageActions>> | undefined
  taskTitles: ReturnType<typeof titlesFromRuns>
  recipientBackends: ReturnType<typeof recipientBackendsFromRuns>
  run: ApiRun
  thread: ThreadState
  history?: RunHistoryState
  footer: ReturnType<typeof threadFooter>
  issueUrl: string | undefined
  scroll: ThreadScrollControls
  mode: ReturnType<typeof threadRenderMode>
}

function ThreadTranscript({
  run, thread, history, footer, issueUrl, sections, renderAsk, renderPermission,
  messageActions, scroll, mode, taskTitles, recipientBackends,
}: ThreadTranscriptProps) {
  /* Row spacing lives on each thread row (pb-2.5, both render modes measure alike);
      this gap only separates the sections — rows, empty state, footer, review panel. */
  return (
    <div data-slot="session-conversation" className="mx-auto flex w-full max-w-[var(--measure)] flex-1 flex-col gap-2.5 px-[18px] py-3 md:gap-3.5 md:px-16 md:py-5">
      {history ? (
        <HistoryBoundary
          hasOlder={history.hasOlder}
          loading={history.isFetchingOlder}
          error={history.olderError}
          fallback={history.fallback}
          retainedPages={history.retainedPages}
          onLoad={scroll.loadOlder}
        />
      ) : null}
      <SessionTranscript
        runId={run.id}
        viewId="main"
        sections={sections}
        mode="document"
        renderAsk={renderAsk}
        renderPermission={renderPermission}
        messageActions={messageActions}
        scrollControls={scroll}
        renderMode={mode}
        taskTitles={taskTitles}
        recipientBackends={recipientBackends}
      />

      {thread.turns.length === 0 ? (
        run.status === 'queued' ? (
          <QueuedPlaceholder run={run} />
        ) : (
          <p data-slot="thread-empty" className="py-6 text-center text-xs text-soft-foreground">
            No session events yet.
          </p>
        )
      ) : null}

      {/* Live turn heartbeat: quiet gaps between bursts still show progress. Monitoring
          keeps `running` while parked, so it must not show the working spinner. */}
      {run.status === 'running' ? <WorkingIndicator /> : null}

      {/* Closed states read as the body's last line; the WAITING state lives in the dock
          (mockup `.paused-hint`), right above the composer it is asking the user to use. */}
      {footer && footer.state === 'closed' ? (
        <div
          data-slot="thread-footer"
          data-state={footer.state}
          className={cn(
            'mt-auto flex items-center gap-2 border-t border-border pt-3 text-xs',
            footer.tone === 'danger' ? 'text-danger' : 'text-soft-foreground',
          )}
        >
          {footer.label}
          {/* href protocol guard (#431): link only for http(s) URLs. */}
          {isHttpUrl(taskPrUrl(run)) ? (
            // The run shipped as a PR (review-gate Draft PR, or agent-opened), or worked on
            // one (#407) — the link stays reachable after the panel is gone.
            <a
              data-slot="pr-link"
              href={taskPrUrl(run)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              PR ↗
            </a>
          ) : null}
          {/* #526: an issue-subject run (om-prepare-issue) links the issue it created — it
              declares no PR, so without this the created issue was unreachable from the UI. */}
          {isHttpUrl(issueUrl) ? (
            <a
              data-slot="issue-link"
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              Issue ↗
            </a>
          ) : null}
        </div>
      ) : null}

      {/* The review gate (spec 009): a finished run with changes parks here — nothing
          auto-merges. The panel exists exactly while the run rests at `review`. */}
      {run.status === 'review' ? <ReviewPanel run={run} /> : null}
    </div>
  )
}

type ThreadComposerProps = {
  run: ApiRun
  thread: ThreadState
  composerRef: RefObject<ComposerHandle | null>
  tellProposed: boolean
  stopAction: ReturnType<typeof useStopAction>
  finishAction: ReturnType<typeof useFinishRun>
  attention: ReturnType<typeof deriveAttention>
  needsAnswer: boolean
  continuable: boolean
  continueAction: ReturnType<typeof useContinueAction>
  queued: boolean
  sendMessage: ReturnType<typeof useSendMessage>
  reply: ReturnType<typeof useAskAnswer>
  providerBlocked: boolean
  providerReason: string | undefined
  sessionOpen: boolean
}

type ThreadFooterDockProps = ThreadComposerProps & {
  currentThread: ThreadState
  scroll: ThreadScrollControls
  pendingQuestions: number
  onJump: () => void
  onOpenWorker: (id: string) => void
}

function ThreadFooterDock({
  run, thread, currentThread, scroll, pendingQuestions, onJump, onOpenWorker,
  sessionOpen, attention, queued, continuable, continueAction, composerRef,
  tellProposed, stopAction, finishAction, needsAnswer, sendMessage, reply,
  providerBlocked, providerReason,
}: ThreadFooterDockProps) {
  /* The footer follows the transcript; desktop keeps it visible while reading history. */
  return (
    <div
      data-slot="thread-dock"
      className="relative z-10 bg-background pt-1 pb-2 md:pt-1.5 md:pb-4"
    >
      {/* Desktop places Jump above the sticky footer; phones keep it in the viewport. */}
      {scroll.pillVisible ? (
        <div data-slot="thread-jump" className="pointer-events-none z-30 flex justify-center">
          <JumpToLatestPill
            pendingQuestions={pendingQuestions}
            onJump={onJump}
          />
        </div>
      ) : null}
      <div data-slot="thread-footer-content" className="mx-auto flex w-full max-w-[var(--measure)] flex-col gap-1.5 px-[14px] md:gap-2.5 md:px-16">
        {/* Keyed by run id, like the docks it replaced: the route survives a task change, so
            an unkeyed dock would carry the previous run's collapse state — its own and every
            nested section's — into the next one. */}
        <RunActivityDock key={run.id} run={run} currentThread={currentThread} onOpenWorker={onOpenWorker} readerScroll={scroll.subscribeReaderScroll} />

        {/* A usage-limit hold is a `waiting` run with a resume booked — the dock says when,
            before the composer offers a Continue nobody needs to press. */}
        <AutoResumeHint run={run} />

        {run.status === 'waiting' && sessionOpen ? (
          <div
            data-slot="paused-hint"
            className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
          >
            <StatusDot tone={attention.tone} shape={attention.shape} pulse={attention.pulse} />
            {attention.bucket === 'permission' ? 'Choose an approval option above to continue'
              : attention.bucket === 'waiting' ? 'The agent is paused, waiting for your reply'
                : `${attention.label.charAt(0).toUpperCase()}${attention.label.slice(1)} — you can send a message to resume`}
          </div>
        ) : null}

        {queued ? (
          <div
            data-slot="queued-hint"
            className="flex items-center gap-2 px-1 text-xs text-muted-foreground"
          >
            {/* The status key's queued mark (#617): a still neutral ring, waiting for a slot. */}
            <StatusDot tone="neutral" shape="ring" />
            Messages you add now are folded into the prompt before the run starts.
          </div>
        ) : null}

        {continuable && continueAction.startsNewConversation ? (
          <p className="px-1 text-xs text-muted-foreground" role="status">Starts a new agent conversation.</p>
        ) : null}

        <ThreadComposer
          run={run}
          thread={thread}
          composerRef={composerRef}
          tellProposed={tellProposed}
          stopAction={stopAction}
          finishAction={finishAction}
          attention={attention}
          needsAnswer={needsAnswer}
          continuable={continuable}
          continueAction={continueAction}
          queued={queued}
          sendMessage={sendMessage}
          reply={reply}
          providerBlocked={providerBlocked}
          providerReason={providerReason}
          sessionOpen={sessionOpen}
        />
      </div>
    </div>
  )
}

function ThreadComposer({
  run, thread, composerRef, tellProposed, stopAction, finishAction, attention,
  needsAnswer, continuable, continueAction, queued, sendMessage, reply,
  providerBlocked, providerReason, sessionOpen,
}: ThreadComposerProps) {
  return (
    <Composer
      ref={composerRef}
      voiceProposal={tellProposed}
      onStop={runActionFlags(run).cancel ? stopAction.stop : undefined}
      onFinish={
        offersComposerFinish(run)
          ? () => finishAction.mutateAsync().catch(() => undefined)
          : undefined
      }
      finishing={finishAction.isPending}
      // Stop's own slot, once Stop is not offered. A failed run holding wait results offers
      // both, so the header carries its Archive and the composer is handed one control.
      secondaryAction={archiveInComposer(run) ? <ArchiveButton run={run} compactOnMobile /> : undefined}
      stopOnEmpty={composerStopsOnEmpty(run, attention, needsAnswer)}
      stopping={stopAction.stopping}
      retainDraftUntilSuccess
      compactFeedback
      pendingLabel={continuable ? 'Continuing…' : 'Sending…'}
      failureHint="Your draft is kept. Check the task status and connection, then retry."
      sessionControls={continuable ? continueAction.pills : undefined}
      onSubmit={
        continuable
          ? (text, images) => continueAction.continueWith(text, images)
          : queued ? (text, images) => sendMessage.mutateAsync({ text, images })
          : async (text, images) => {
              // Share the ask card's idle-close recovery. The composer clears its draft
              // only on success, so convert the hook's returned failure to a rejection.
              const error = await reply.send(text, images)
              if (error !== undefined) throw new Error(error)
            }
      }
      disabled={providerBlocked || (!sessionOpen && !queued && !continuable)}
      disabledReason={providerBlocked ? providerReason : 'Session closed — no session to resume.'}
      // The engine pills ride the enabled footer, so the picked runner/model and the
      // typed prompt reach `POST /continue` in one request.
      footerEnd={
        providerBlocked && !continueAction.providerPending ? (
          <Link
            to="/settings/agents#providers"
            className="text-xs font-medium text-foreground underline underline-offset-4"
          >
            Configure providers
          </Link>
        ) : undefined
      }
      // Continuing with nothing typed is the legacy one-click Continue.
      allowEmptySubmit={continuable && !needsAnswer}
      emptySubmitLabel={continuable && !needsAnswer ? 'Continue' : undefined}
      placeholder={threadComposerPlaceholder(run, queued, continuable)}
      autocompleteSkills
      quickReplies
      getMentionCandidates={() => threadFilePaths(thread)}
    />
  )
}

function composerStopsOnEmpty(run: ApiRun, attention: ReturnType<typeof deriveAttention>, needsAnswer: boolean) {
  return run.status === 'queued' || run.status === 'running' || (run.status === 'waiting' && attention.bucket === 'none' && !needsAnswer)
}

function threadComposerPlaceholder(run: ApiRun, queued: boolean, continuable: boolean) {
  return queued ? 'Add to the prompt — sent when the run starts…'
    : continuable ? 'Continue — add a prompt, or send to just reopen the session…'
    : run.status === 'waiting' ? 'Reply — / for skills, @ for files…'
    : 'Message the agent — / for skills, @ for files…'
}

function HistoryBoundary({
  hasOlder,
  loading,
  error,
  fallback,
  retainedPages,
  onLoad,
}: {
  hasOlder: boolean
  loading: boolean
  error?: string
  fallback: boolean
  retainedPages: number
  onLoad: () => void
}) {
  if (fallback) {
    return (
      <p data-slot="history-fallback" className="text-center text-xs text-soft-foreground" role="status">
        Progressive history is unavailable; showing the complete session.
      </p>
    )
  }
  if (!hasOlder && !error) {
    return (
      <div data-slot="history-start" className="flex items-center gap-3 text-[11px] text-soft-foreground">
        <span aria-hidden className="h-px flex-1 bg-border" />
        Start of session
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
    )
  }
  return (
    <div
      data-slot="history-boundary"
      data-retained-pages={retainedPages}
      aria-busy={loading}
      className="flex min-h-8 items-center justify-center text-xs text-muted-foreground"
    >
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className="rounded-md px-3 py-1.5 font-medium hover:bg-muted disabled:cursor-wait"
      >
        {loading ?
          'Loading 100 earlier items…'
        : error ?
          'Couldn’t load earlier items · Retry'
        : 'Load 100 earlier items'}
      </button>
      <span className="sr-only" aria-live="polite">
        {loading ? 'Loading earlier session history' : error ? error : ''}
      </span>
    </div>
  )
}

/** The queued run's honest empty state (legacy #351): a queued run has emitted nothing, so
 *  instead of a blank thread the placeholder names the parked state and its live position in
 *  the FIFO queue (from the runs list — the same feed the sidebar uses). */
function QueuedPlaceholder({ run }: { run: ApiRun }) {
  const runs = useRuns()
  const position = queuePosition(runs.data ?? [], run.id)
  return (
    <div data-slot="queued-state" className="flex flex-col items-center gap-1.5 py-10 text-center">
      <StatusDot tone="neutral" shape="ring" />
      <p className="text-[13px] font-medium">
        Waiting for a free agent slot{position !== undefined ? ` — #${position} in queue` : ''}
      </p>
      <p className="text-xs text-soft-foreground">
        {run.workflow} · starts automatically when a slot frees up
      </p>
    </div>
  )
}
