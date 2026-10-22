import { act, cleanup, renderHook } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunSummary, VoiceAnswer, VoiceDecideRequest, VoiceDecision } from '@open-mercato/cezar-api-client'
import { voiceRun } from '@/lib/voice/fixture.testkit'
import { resetVoiceStoreForTests, voiceStore, type AskCardTarget } from '@/lib/voice/proposal-store'

const mocks = vi.hoisted(() => ({
  voiceDecide: vi.fn(),
  reportVoiceOutcome: vi.fn(),
  navigate: vi.fn(),
  openRunId: null as string | null,
  /** The page path without its project prefix; defaults to the open task's thread, or `/`. */
  path: undefined as string | undefined,
  projectId: 'proj-a' as string | null,
  runs: [] as unknown[],
}))

vi.mock('@/api/client', () => ({ voiceDecide: mocks.voiceDecide, reportVoiceOutcome: mocks.reportVoiceOutcome }))
vi.mock('@/api/queries', () => ({ useRuns: () => ({ data: mocks.runs }) }))
vi.mock('@/components/list-view', () => ({ useListView: () => ['active', () => {}] }))
vi.mock('@/lib/project-router', () => ({
  useNavigate: () => mocks.navigate,
  useProjectMatch: () => (mocks.openRunId === null ? null : { params: { id: mocks.openRunId } }),
  useActiveProjectId: () => mocks.projectId,
  useProjectPathname: () => mocks.path ?? (mocks.openRunId === null ? '/' : `/tasks/${mocks.openRunId}`),
}))

const { looksLikeSentence, useVoiceCommand } = await import('./use-voice-command')

/** One engine request the test answers by hand. The mock ignores the abort signal on purpose, so
 *  a late answer to an aborted request still arrives and the hook has to ignore it itself. */
interface Call {
  input: VoiceDecideRequest
  signal: AbortSignal | undefined
  resolve(decision: VoiceDecision): void
  reject(error: unknown): void
}
let calls: Call[] = []

const DECISION_ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeEach(() => {
  vi.useFakeTimers()
  resetVoiceStoreForTests()
  calls = []
  mocks.voiceDecide.mockReset()
  mocks.voiceDecide.mockImplementation(
    (input: VoiceDecideRequest, signal?: AbortSignal) =>
      new Promise<VoiceDecision>((resolve, reject) => calls.push({ input, signal, resolve, reject })),
  )
  mocks.reportVoiceOutcome.mockReset()
  mocks.navigate.mockReset()
  mocks.openRunId = null
  mocks.path = undefined
  mocks.projectId = 'proj-a'
  mocks.runs = []
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup({ enabled = true, text = '' }: { enabled?: boolean; text?: string } = {}) {
  const close = vi.fn()
  const hook = renderHook(() => {
    const [current, setText] = useState(text)
    const voice = useVoiceCommand({ enabled, text: current, close, clearText: () => setText('') })
    return { voice, text: current, setText }
  })
  return { ...hook, close }
}

type Harness = ReturnType<typeof setup>

function enter(harness: Harness, { repeat = false }: { repeat?: boolean } = {}) {
  const event = { key: 'Enter', repeat, preventDefault: vi.fn(), nativeEvent: { isComposing: false } }
  let handled = false
  act(() => {
    handled = harness.result.current.voice.onEnter(event as unknown as KeyboardEvent)
  })
  return { handled, event }
}

const type = (harness: Harness, text: string) => act(() => harness.result.current.setText(text))
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const answer = async (call: Call | undefined, decision: VoiceDecision) => {
  if (!call) throw new Error('no engine request to answer')
  await act(async () => call.resolve(decision))
}

function card(headers: string[], overrides: Partial<AskCardTarget> = {}): AskCardTarget {
  let applied: VoiceAnswer[] = []
  return {
    runId: 'r1',
    requestId: 'ask_1',
    headers,
    read: () => ({ selections: {}, otherAnswers: {} }),
    apply: vi.fn((answers: VoiceAnswer[]) => {
      applied = answers
    }),
    restore: vi.fn(() => {
      applied = []
    }),
    unanswered: () => headers.flatMap((_, index) => (applied.some((entry) => entry.question === index) ? [] : [index])),
    send: vi.fn(() => true),
    ...overrides,
  }
}

const answerDecision = (n: number, answers: VoiceAnswer[], runId = 'r1'): VoiceDecision => ({
  action: 'answer',
  decisionId: DECISION_ID(n),
  runId,
  askRequestId: 'ask_1',
  answers,
  confidence: 0.9,
})
const option = (question: number, ...labels: string[]): VoiceAnswer => ({ question, kind: 'option', labels })

/** Shows an answer proposal for `r1`, the way a committed sentence does. */
async function proposeAnswer(harness: Harness, n: number, answers: VoiceAnswer[]) {
  type(harness, `answer number ${n}`)
  enter(harness)
  await answer(calls.at(-1), answerDecision(n, answers))
}

/** One ordinary cmdk row, selected; returns its click spy. */
function selectedItem() {
  const item = document.createElement('div')
  item.setAttribute('cmdk-item', '')
  item.setAttribute('data-selected', 'true')
  const click = vi.fn()
  item.addEventListener('click', click)
  document.body.append(item)
  return click
}

const failed = (over: Parameters<typeof voiceRun>[0] = {}): RunSummary => voiceRun({ status: 'failed', ...over })

describe('looksLikeSentence', () => {
  it('needs two words after trimming', () => {
    expect(looksLikeSentence('  open  ')).toBe(false)
    expect(looksLikeSentence('open next')).toBe(true)
    expect(looksLikeSentence(' open\tnext ')).toBe(true)
  })
})

describe('useVoiceCommand', () => {
  it('makes no request when voice is off', async () => {
    const harness = setup({ enabled: false, text: 'open the next failed task' })
    await advance(5000)
    expect(enter(harness).handled).toBe(false)
    await advance(5000)
    expect(mocks.voiceDecide).not.toHaveBeenCalled()
    expect(harness.result.current.voice.row).toBeUndefined()
    expect(harness.result.current.voice.mode).toBe('idle')
  })

  it('previews after 300 ms and shows a Will do row', async () => {
    mocks.runs = [failed({ id: 'a', title: 'Fix flaky shard' })]
    const harness = setup()
    type(harness, 'open the next failed task')
    await advance(299)
    expect(mocks.voiceDecide).not.toHaveBeenCalled()
    await advance(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ text: 'open the next failed task', sidebarView: 'active', view: 'other' })

    await answer(calls[0], { action: 'open', decisionId: DECISION_ID(1), status: 'failed', position: 'next', confidence: 0.9 })

    expect(harness.result.current.voice.row).toEqual({ kind: 'will-do', text: 'Open “Fix flaky shard” — next failed' })
    expect(harness.result.current.voice.mode).toBe('preview')
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('ignores a decision for text that has since changed', async () => {
    mocks.runs = [failed({ id: 'a', title: 'Alpha' }), voiceRun({ id: 'b', title: 'Bravo', status: 'done' })]
    const harness = setup()
    type(harness, 'open the next failed task')
    await advance(300)
    type(harness, 'open the first done task')
    expect(calls[0]?.signal?.aborted).toBe(true)
    await advance(300)
    expect(calls).toHaveLength(2)

    // The aborted request answers late anyway: it must not reach the row.
    await answer(calls[0], { action: 'open', decisionId: DECISION_ID(1), status: 'failed', position: 'next', confidence: 0.9 })
    expect(harness.result.current.voice.row).toBeUndefined()

    await answer(calls[1], { action: 'open', decisionId: DECISION_ID(2), status: 'done', position: 1, confidence: 0.9 })
    expect(harness.result.current.voice.row).toEqual({ kind: 'will-do', text: 'Open “Bravo” — first done' })
  })

  it('waits on Enter for the pending decision, then opens the task', async () => {
    mocks.runs = [failed({ id: 'a', title: 'Alpha' })]
    const harness = setup()
    type(harness, 'open the next failed task')

    const { handled, event } = enter(harness)
    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    // Return does not wait for the debounce: the request starts now.
    expect(calls).toHaveLength(1)
    expect(mocks.navigate).not.toHaveBeenCalled()

    await answer(calls[0], { action: 'open', decisionId: DECISION_ID(1), status: 'failed', position: 'next', confidence: 0.9 })

    expect(mocks.navigate).toHaveBeenCalledWith('/tasks/a')
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'executed')
    expect(harness.close).toHaveBeenCalled()
    // The preview the debounce would have started reuses the committed request.
    await advance(300)
    expect(calls).toHaveLength(1)
  })

  it('opens a variant group at its compare page', async () => {
    mocks.runs = [failed({ id: 'g1', groupId: 'grp', title: 'Shared · A' }), failed({ id: 'g2', groupId: 'grp', title: 'Shared · B' })]
    const harness = setup({ text: 'open the first failed task' })
    enter(harness)
    await answer(calls[0], { action: 'open', decisionId: DECISION_ID(1), status: 'failed', position: 1, confidence: 0.9 })
    expect(mocks.navigate).toHaveBeenCalledWith('/compare/grp')
  })

  it('says why nothing opens: an empty list, a position past its end', async () => {
    mocks.runs = [failed({ id: 'a' })]
    const harness = setup({ text: 'open the next done task' })
    enter(harness)
    await answer(calls[0], { action: 'open', decisionId: DECISION_ID(1), status: 'done', position: 'next', confidence: 0.9 })
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'No done tasks.' })

    type(harness, 'open the third failed task')
    enter(harness)
    await answer(calls[1], { action: 'open', decisionId: DECISION_ID(2), status: 'failed', position: 3, confidence: 0.9 })
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'No third failed task.' })

    type(harness, 'open the next waiting for ci task')
    enter(harness)
    await answer(calls[2], { action: 'open', decisionId: DECISION_ID(3), status: 'waiting-for-ci', position: 'next', confidence: 0.9 })
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'No waiting for CI tasks.' })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('the committing Enter never confirms', async () => {
    mocks.openRunId = 'r1'
    voiceStore.registerAskCard(card(['Library']))
    const confirm = vi.spyOn(voiceStore, 'confirm')
    const harness = setup()
    type(harness, 'answer vitest to question one')

    enter(harness)
    // A second Return before the decision arrives is still part of committing the sentence.
    enter(harness)
    await answer(calls[0], answerDecision(1, [option(0, 'Vitest')]))

    expect(voiceStore.getProposal()).toMatchObject({ decisionId: DECISION_ID(1) })
    expect(confirm).not.toHaveBeenCalled()
    expect(harness.result.current.text).toBe('')
    expect(harness.result.current.voice.mode).toBe('proposal')
    expect(harness.result.current.voice.row).toEqual({ kind: 'will-do', text: 'Answer Library: Vitest' })

    // A later Return in the emptied input is the confirmation.
    expect(enter(harness).handled).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'confirmed')
    expect(harness.close).toHaveBeenCalled()
  })

  it('a held Return never commits or confirms; a fresh press confirms', async () => {
    mocks.openRunId = 'r1'
    const target = card(['Library'])
    voiceStore.registerAskCard(target)
    const harness = setup()
    type(harness, 'answer vitest to question one')

    // The key that commits the sentence stays down: its repeats arrive before and after the decision.
    expect(enter(harness).handled).toBe(true)
    const early = enter(harness, { repeat: true })
    expect(early.handled).toBe(true)
    expect(early.event.preventDefault).toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    await answer(calls[0], answerDecision(1, [option(0, 'Vitest')]))
    expect(harness.result.current.text).toBe('')

    for (let i = 0; i < 3; i++) {
      const held = enter(harness, { repeat: true })
      expect(target.send).not.toHaveBeenCalled()
      expect(held.handled).toBe(true)
      expect(held.event.preventDefault).toHaveBeenCalled()
    }
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: DECISION_ID(1) })

    expect(enter(harness).handled).toBe(true)
    expect(target.send).toHaveBeenCalledTimes(1)
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'confirmed')
  })

  it('a held Return with no sentence and no proposal keeps the default Return', () => {
    const harness = setup()
    type(harness, 'open')
    expect(enter(harness, { repeat: true }).handled).toBe(false)
    type(harness, '')
    expect(enter(harness, { repeat: true }).handled).toBe(false)
    expect(mocks.voiceDecide).not.toHaveBeenCalled()
  })

  it('refuses to confirm with an unanswered question', async () => {
    mocks.openRunId = 'r1'
    const target = card(['Library', 'Build'])
    voiceStore.registerAskCard(target)
    const harness = setup()
    await proposeAnswer(harness, 1, [option(0, 'Vitest')])

    enter(harness)

    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'Question 2 (Build) still needs an answer.' })
    expect(target.send).not.toHaveBeenCalled()
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: DECISION_ID(1) })
    expect(mocks.reportVoiceOutcome).not.toHaveBeenCalled()
    expect(harness.close).not.toHaveBeenCalled()
  })

  it('a busy card keeps the proposal and reports nothing', async () => {
    mocks.openRunId = 'r1'
    voiceStore.registerAskCard(card(['Library'], { send: vi.fn(() => false) }))
    const harness = setup()
    await proposeAnswer(harness, 1, [option(0, 'Vitest')])

    enter(harness)

    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'The task is busy. Try again in a moment.' })
    expect(voiceStore.getProposal()).toBeDefined()
    expect(mocks.reportVoiceOutcome).not.toHaveBeenCalled()
  })

  it('reports replaced when a new sentence replaces the proposal', async () => {
    mocks.openRunId = 'r1'
    voiceStore.registerAskCard(card(['Library', 'Build']))
    const harness = setup()
    await proposeAnswer(harness, 1, [option(0, 'Vitest')])
    await proposeAnswer(harness, 2, [option(1, 'Fast')])

    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'replaced')
    expect(harness.result.current.voice.row).toEqual({ kind: 'will-do', text: 'Answer Library: Vitest; Build: Fast' })
  })

  it('says why a proposal could not be made', async () => {
    mocks.openRunId = 'r1'
    const harness = setup({ text: 'answer vitest to question one' })
    enter(harness)
    await answer(calls[0], answerDecision(1, [option(0, 'Vitest')]))
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'This question is not open here.' })

    voiceStore.registerComposer({
      runId: 'r1',
      getDraft: () => 'my own words',
      setDraft: () => true,
      clearVoiceDraft: () => true,
      submit: () => true,
    })
    type(harness, 'tell it: ship it')
    enter(harness)
    await answer(calls[1], { action: 'tell', decisionId: DECISION_ID(2), runId: 'r1', text: 'ship it', confidence: 0.9 })
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'The message box already has text.' })
    expect(voiceStore.getProposal()).toBeUndefined()
  })

  it('drops a decision made for another open task', async () => {
    mocks.openRunId = 'r1'
    voiceStore.registerAskCard(card(['Library']))
    const harness = setup({ text: 'answer vitest to question one' })

    // The open task changes while the request is in flight.
    enter(harness)
    mocks.openRunId = 'r2'
    harness.rerender()
    await answer(calls[0], answerDecision(1, [option(0, 'Vitest')]))
    expect(voiceStore.getProposal()).toBeUndefined()

    // The open task stays, but the decision names another run.
    mocks.openRunId = 'r1'
    harness.rerender()
    type(harness, 'answer jest to question one')
    enter(harness)
    await answer(calls.at(-1), answerDecision(2, [option(0, 'Jest')], 'r9'))
    expect(voiceStore.getProposal()).toBeUndefined()
    expect(harness.result.current.voice.row).toBeUndefined()
    expect(mocks.reportVoiceOutcome).not.toHaveBeenCalled()
  })

  it('numbered alternatives pick with "two"', async () => {
    mocks.runs = [failed({ id: 'a', title: 'Alpha' }), voiceRun({ id: 'c', title: 'Charlie', status: 'done' })]
    const harness = setup({ text: 'open the next failed one' })
    enter(harness)
    await answer(calls[0], {
      action: 'open',
      decisionId: DECISION_ID(1),
      status: 'failed',
      position: 'next',
      confidence: 0.4,
      // The second resolves to nothing and is left out.
      alternatives: [{ status: 'done', position: 1 }, { status: 'queued', position: 1 }],
    })

    expect(harness.result.current.voice.mode).toBe('choosing')
    expect(harness.result.current.text).toBe('')
    expect(harness.result.current.voice.row).toEqual({
      kind: 'will-do',
      text: 'Which one?',
      choices: ['Open “Alpha” — next failed', 'Open “Charlie” — first done'],
    })
    expect(mocks.navigate).not.toHaveBeenCalled()

    type(harness, 'two')
    await advance(1000)
    expect(enter(harness).handled).toBe(true)

    expect(mocks.navigate).toHaveBeenCalledWith('/tasks/c')
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'executed')
    expect(mocks.voiceDecide).toHaveBeenCalledTimes(1)
  })

  it('"yes, confirmed" committed while a proposal is shown confirms it', async () => {
    mocks.openRunId = 'r1'
    const target = card(['Library'])
    voiceStore.registerAskCard(target)
    const harness = setup()
    await proposeAnswer(harness, 1, [option(0, 'Vitest')])

    type(harness, 'yes, confirmed')
    await advance(300)
    expect(calls.at(-1)?.input).toEqual({
      text: 'yes, confirmed',
      sidebarView: 'active',
      view: 'task',
      openRunId: 'r1',
      proposal: { decisionId: DECISION_ID(1), action: 'answer' },
    })
    await answer(calls.at(-1), { action: 'confirm', decisionId: DECISION_ID(2) })
    expect(harness.result.current.voice.row).toEqual({ kind: 'will-do', text: 'Send it' })
    expect(target.send).not.toHaveBeenCalled()

    enter(harness)
    await advance(0)

    expect(target.send).toHaveBeenCalledTimes(1)
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'confirmed')
    expect(harness.close).toHaveBeenCalled()
  })

  it('a confirm decision for a sentence committed with no proposal shown only says so', async () => {
    mocks.openRunId = 'r1'
    voiceStore.registerAskCard(card(['Library']))
    const confirm = vi.spyOn(voiceStore, 'confirm')
    const harness = setup({ text: 'yes, confirmed' })

    enter(harness)
    await answer(calls[0], { action: 'confirm', decisionId: DECISION_ID(1) })

    expect(confirm).not.toHaveBeenCalled()
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'Not sure what to do. Try again.' })
    expect(harness.close).not.toHaveBeenCalled()
  })

  it('a committed cancel drops the proposal and reports cancelled', async () => {
    mocks.openRunId = 'r1'
    const target = card(['Library'])
    voiceStore.registerAskCard(target)
    const harness = setup()
    await proposeAnswer(harness, 1, [option(0, 'Vitest')])

    type(harness, 'no, cancel that')
    enter(harness)
    await answer(calls.at(-1), { action: 'cancel', decisionId: DECISION_ID(2) })

    expect(voiceStore.getProposal()).toBeUndefined()
    expect(target.restore).toHaveBeenCalled()
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'cancelled')
    expect(harness.result.current.text).toBe('')
  })

  it('Esc cancels a proposal and reports cancelled', async () => {
    mocks.openRunId = 'r1'
    const target = card(['Library'])
    voiceStore.registerAskCard(target)
    const harness = setup()
    await proposeAnswer(harness, 1, [option(0, 'Vitest')])

    act(() => harness.result.current.voice.onClose())

    expect(voiceStore.getProposal()).toBeUndefined()
    expect(target.restore).toHaveBeenCalled()
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'cancelled')
    // The palette unmounting afterwards reports nothing more.
    harness.unmount()
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledTimes(1)
  })

  it('closing with a preview never acted on reports abandoned, once', async () => {
    mocks.runs = [failed({ id: 'a' })]
    const harness = setup({ text: 'open the next failed task' })
    await advance(300)
    await answer(calls[0], { action: 'open', decisionId: DECISION_ID(1), status: 'failed', position: 'next', confidence: 0.9 })

    act(() => harness.result.current.voice.onClose())
    harness.unmount()

    expect(mocks.reportVoiceOutcome).toHaveBeenCalledTimes(1)
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'abandoned')
  })

  it('a proposal the store drops on its own is abandoned, with a line saying why', async () => {
    mocks.openRunId = 'r1'
    voiceStore.registerAskCard(card(['Library']))
    const harness = setup()
    await proposeAnswer(harness, 1, [option(0, 'Vitest')])

    act(() => voiceStore.syncPendingAsk('r1', undefined))

    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'abandoned')
    expect(harness.result.current.voice.mode).toBe('idle')
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'The question was answered or closed elsewhere.' })
  })

  it('Return finds the card off screen: the answers stay, nothing is sent, and a remount confirms', async () => {
    mocks.openRunId = 'r1'
    const target = card(['Library'])
    const unregister = voiceStore.registerAskCard(target)
    const harness = setup()
    await proposeAnswer(harness, 1, [option(0, 'Vitest')])

    // The card scrolls out of a virtualized thread; its question stays open.
    unregister()
    enter(harness)

    expect(voiceStore.getProposal()).toMatchObject({ decisionId: DECISION_ID(1) })
    expect(mocks.reportVoiceOutcome).not.toHaveBeenCalled()
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'Scroll to the question, then confirm.' })
    expect(target.send).not.toHaveBeenCalled()
    expect(harness.close).not.toHaveBeenCalled()

    // The same question mounts again: the store re-applies the answers and a fresh Return confirms.
    const remounted = card(['Library'])
    voiceStore.registerAskCard(remounted)
    expect(remounted.apply).toHaveBeenCalledWith([option(0, 'Vitest')], { reveal: false })
    enter(harness)

    expect(remounted.send).toHaveBeenCalledTimes(1)
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledTimes(1)
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'confirmed')
  })

  it('a tell whose composer is gone is dropped as a closed task', async () => {
    mocks.openRunId = 'r1'
    const unregister = voiceStore.registerComposer({
      runId: 'r1',
      getDraft: () => '',
      setDraft: () => true,
      clearVoiceDraft: () => true,
      submit: () => true,
    })
    const harness = setup()
    type(harness, 'tell it: ship it')
    enter(harness)
    await answer(calls[0], { action: 'tell', decisionId: DECISION_ID(1), runId: 'r1', text: 'ship it', confidence: 0.9 })
    expect(voiceStore.getProposal()).toMatchObject({ kind: 'tell' })

    act(() => unregister())
    enter(harness)

    expect(voiceStore.getProposal()).toBeUndefined()
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledTimes(1)
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'abandoned')
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'The task is no longer open.' })
  })

  it('"not a command" lets Return do what it does today', async () => {
    const item = document.createElement('div')
    item.setAttribute('cmdk-item', '')
    item.setAttribute('data-selected', 'true')
    const click = vi.fn()
    item.addEventListener('click', click)
    document.body.append(item)
    const harness = setup({ text: 'fix the flaky shard' })

    enter(harness)
    await answer(calls[0], { action: 'none', decisionId: DECISION_ID(1), reason: 'not-a-command' })

    expect(click).toHaveBeenCalledTimes(1)
    expect(harness.result.current.voice.row).toBeUndefined()
  })

  it('names what the engine could not do', async () => {
    const harness = setup()
    const cases = [
      ['no-open-task', 'Open a task first.'],
      ['no-open-question', 'This task has no open question.'],
      ['unclear', 'Not sure what to do. Try again.'],
    ] as const
    for (const [index, [reason, text]] of cases.entries()) {
      type(harness, `sentence number ${index}`)
      enter(harness)
      await answer(calls.at(-1), { action: 'none', decisionId: DECISION_ID(index + 1), reason })
      expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text })
    }
  })

  it('a failed decision says so and falls back to the selected item', async () => {
    const item = document.createElement('div')
    item.setAttribute('cmdk-item', '')
    item.setAttribute('data-selected', 'true')
    const click = vi.fn()
    item.addEventListener('click', click)
    document.body.append(item)
    const harness = setup({ text: 'open the next failed task' })

    enter(harness)
    await act(async () => calls[0]?.reject(new Error('503')))

    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'Voice decision unavailable.' })
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('Return waits at most 3000 ms for the decision, then falls back to the selected item', async () => {
    const click = selectedItem()
    mocks.runs = [failed({ id: 'a' })]
    const harness = setup({ text: 'open the next failed task' })

    enter(harness)
    await advance(2999)
    expect(harness.result.current.voice.row).toBeUndefined()
    expect(click).not.toHaveBeenCalled()
    await advance(1)

    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text: 'Voice decision timed out.' })
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(click).toHaveBeenCalledTimes(1)
    // The decision that arrives after the bound does nothing.
    await answer(calls[0], { action: 'open', decisionId: DECISION_ID(1), status: 'failed', position: 'next', confidence: 0.9 })
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.reportVoiceOutcome).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('with a proposal shown, "no" and "Cancel." drop it in the browser', async () => {
    mocks.openRunId = 'r1'
    const target = card(['Library'])
    voiceStore.registerAskCard(target)
    const harness = setup()

    for (const [n, word] of [[1, 'no'], [2, 'Cancel.']] as const) {
      await proposeAnswer(harness, n, [option(0, 'Vitest')])
      const engineCalls = mocks.voiceDecide.mock.calls.length
      type(harness, word)
      await advance(1000)

      expect(enter(harness).handled).toBe(true)

      expect(voiceStore.getProposal()).toBeUndefined()
      expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(n), 'cancelled')
      expect(harness.result.current.text).toBe('')
      expect(harness.result.current.voice.mode).toBe('idle')
      expect(mocks.voiceDecide).toHaveBeenCalledTimes(engineCalls)
    }
    expect(target.restore).toHaveBeenCalledTimes(2)
  })

  it('with no proposal shown, "no" stays an ordinary search', async () => {
    const harness = setup({ text: 'no' })
    await advance(1000)
    expect(enter(harness).handled).toBe(false)
    expect(mocks.voiceDecide).not.toHaveBeenCalled()
  })

  it('a preview candidate acts when clicked, for the context it was shown in only', async () => {
    mocks.runs = [failed({ id: 'a', title: 'Alpha' }), voiceRun({ id: 'c', title: 'Charlie', status: 'done' })]
    const harness = setup({ text: 'open the next failed one' })
    await advance(300)
    await answer(calls[0], {
      action: 'open',
      decisionId: DECISION_ID(1),
      status: 'failed',
      position: 'next',
      confidence: 0.4,
      alternatives: [{ status: 'done', position: 1 }],
    })
    expect(harness.result.current.voice.row?.choices).toHaveLength(2)

    // The open task changed since the preview: its candidates are not shown, and a click does nothing.
    mocks.openRunId = 'elsewhere'
    harness.rerender()
    act(() => harness.result.current.voice.onSelect(1))
    expect(mocks.navigate).not.toHaveBeenCalled()

    mocks.openRunId = null
    harness.rerender()
    act(() => harness.result.current.voice.onSelect(1))
    expect(mocks.navigate).toHaveBeenCalledWith('/tasks/c')
    expect(mocks.reportVoiceOutcome).toHaveBeenCalledWith(DECISION_ID(1), 'executed')
    expect(harness.close).toHaveBeenCalled()
  })

  it('numbered choices are dropped when the open task changes', async () => {
    mocks.runs = [failed({ id: 'a', title: 'Alpha' }), voiceRun({ id: 'c', title: 'Charlie', status: 'done' })]
    const harness = setup({ text: 'open the next failed one' })
    enter(harness)
    await answer(calls[0], {
      action: 'open',
      decisionId: DECISION_ID(1),
      status: 'failed',
      position: 'next',
      confidence: 0.4,
      alternatives: [{ status: 'done', position: 1 }],
    })
    expect(harness.result.current.voice.mode).toBe('choosing')

    mocks.openRunId = 'a'
    harness.rerender()
    expect(harness.result.current.voice.mode).toBe('idle')
    expect(harness.result.current.voice.row).toBeUndefined()

    type(harness, 'two')
    expect(enter(harness).handled).toBe(false)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('sends view and the shown card', async () => {
    mocks.openRunId = 'r1'
    voiceStore.syncPendingAsk('r1', 'ask_1')
    const harness = setup()
    type(harness, 'answer vitest to question one')
    await advance(300)
    expect(calls[0]?.input).toEqual({
      text: 'answer vitest to question one',
      sidebarView: 'active',
      view: 'task',
      openRunId: 'r1',
      askRequestId: 'ask_1',
    })

    // A thread that shows no question sends null, so the server can refuse a decision made for one.
    act(() => voiceStore.syncPendingAsk('r1', undefined))
    await advance(300)
    expect(calls[1]?.input).toMatchObject({ openRunId: 'r1', askRequestId: null })
  })

  it('omits askRequestId before the thread syncs', async () => {
    mocks.openRunId = 'r1'
    const harness = setup()
    type(harness, 'tell it to run the tests')
    await advance(300)
    expect(calls[0]?.input).toEqual({ text: 'tell it to run the tests', sidebarView: 'active', view: 'task', openRunId: 'r1' })
  })

  it('drops a preview when the card changes', async () => {
    mocks.openRunId = 'r1'
    voiceStore.registerAskCard(card(['Library']))
    voiceStore.syncPendingAsk('r1', 'ask_1')
    const harness = setup()
    type(harness, 'answer vitest to question one')
    await advance(300)
    await answer(calls[0], answerDecision(1, [option(0, 'Vitest')]))
    expect(harness.result.current.voice.row).toEqual({ kind: 'will-do', text: 'Answer Library: Vitest' })

    act(() => voiceStore.syncPendingAsk('r1', 'ask_2'))
    expect(harness.result.current.voice.row).toBeUndefined()
    enter(harness)
    // Return asks again for the question now shown, and never acts on the old decision.
    expect(calls).toHaveLength(2)
    expect(calls[1]?.input).toMatchObject({ askRequestId: 'ask_2' })
    expect(voiceStore.getProposal()).toBeUndefined()
  })

  it('ends a choice when the page changes', async () => {
    mocks.runs = [failed({ id: 'a', title: 'Alpha' }), voiceRun({ id: 'c', title: 'Charlie', status: 'done' })]
    const harness = setup({ text: 'open the next failed one' })
    enter(harness)
    await answer(calls[0], {
      action: 'open',
      decisionId: DECISION_ID(1),
      status: 'failed',
      position: 'next',
      confidence: 0.4,
      alternatives: [{ status: 'done', position: 1 }],
    })
    expect(harness.result.current.voice.mode).toBe('choosing')

    mocks.path = '/settings'
    harness.rerender()
    expect(harness.result.current.voice.mode).toBe('idle')
  })

  it.each([
    ['ambiguous', 'Which question? Name it, for example “to question two”.'],
    ['stale-context', 'The screen changed. Try again.'],
    ['unsupported', 'Voice cannot do that yet.'],
  ] as const)('shows the %s notice', async (reason, text) => {
    const harness = setup()
    type(harness, 'answer it somehow')
    await advance(300)
    await answer(calls[0], { action: 'none', decisionId: DECISION_ID(1), reason })
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text })
    enter(harness)
    await advance(0)
    expect(harness.result.current.voice.row).toEqual({ kind: 'notice', text })
  })

  it('names the task in the answer and tell rows', async () => {
    mocks.openRunId = 'r1'
    mocks.runs = [voiceRun({ id: 'r1', title: 'Fix flaky shard', status: 'waiting' })]
    voiceStore.registerAskCard(card(['Library', 'Build']))
    const harness = setup()
    type(harness, 'answer vitest to question one')
    await advance(300)
    await answer(calls[0], answerDecision(1, [option(0, 'Vitest')]))
    expect(harness.result.current.voice.row).toEqual({ kind: 'will-do', text: 'Answer “Fix flaky shard”: Library: Vitest' })

    type(harness, 'tell it: ship it')
    await advance(300)
    await answer(calls[1], { action: 'tell', decisionId: DECISION_ID(2), runId: 'r1', text: 'ship it', confidence: 0.9 })
    expect(harness.result.current.voice.row).toEqual({ kind: 'will-do', text: 'Tell “Fix flaky shard”: ship it' })
  })

  it('drops a preview and a choice when the project changes under an open palette', async () => {
    mocks.runs = [failed({ id: 'a', title: 'Alpha' }), voiceRun({ id: 'c', title: 'Charlie', status: 'done' })]
    const harness = setup({ text: 'open the next failed one' })
    await advance(300)
    await answer(calls[0], {
      action: 'open',
      decisionId: DECISION_ID(1),
      status: 'failed',
      position: 'next',
      confidence: 0.4,
      alternatives: [{ status: 'done', position: 1 }],
    })
    expect(harness.result.current.voice.row).toMatchObject({ text: 'Which one?' })

    // Back/Forward to another project: same page kind, no open task, the palette stays mounted.
    mocks.projectId = 'proj-b'
    harness.rerender()
    expect(harness.result.current.voice.row).toBeUndefined()
    enter(harness)
    expect(calls).toHaveLength(2)

    await answer(calls[1], {
      action: 'open',
      decisionId: DECISION_ID(2),
      status: 'failed',
      position: 'next',
      confidence: 0.4,
      alternatives: [{ status: 'done', position: 1 }],
    })
    expect(harness.result.current.voice.mode).toBe('choosing')
    mocks.projectId = 'proj-a'
    harness.rerender()
    expect(harness.result.current.voice.mode).toBe('idle')
    type(harness, 'two')
    expect(enter(harness).handled).toBe(false)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('a single word never calls the engine and keeps the default Return', async () => {
    const harness = setup({ text: 'settings' })
    await advance(1000)
    expect(enter(harness).handled).toBe(false)
    await advance(5000)
    expect(mocks.voiceDecide).not.toHaveBeenCalled()
  })
})
