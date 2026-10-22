import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceAnswer } from '@open-mercato/cezar-api-client'
import {
  resetVoiceStoreForTests,
  voiceStore,
  type AskCardTarget,
  type AskCardValues,
  type ComposerTarget,
  type VoiceProposal,
} from './proposal-store'

beforeEach(() => resetVoiceStoreForTests())

const EMPTY: AskCardValues = { selections: {}, otherAnswers: {} }

/** A card that remembers what was applied and answers `unanswered` from it, like the real one. */
function fakeCard(overrides: Partial<AskCardTarget> = {}, values: AskCardValues = EMPTY) {
  let applied: VoiceAnswer[] = []
  const target: AskCardTarget = {
    runId: 'r1',
    requestId: 'ask_1',
    headers: ['Library', 'Build'],
    read: vi.fn(() => values),
    apply: vi.fn((answers: VoiceAnswer[]) => {
      applied = answers
    }),
    restore: vi.fn(() => {
      applied = []
    }),
    unanswered: vi.fn(() => [0, 1].filter((index) => !applied.some((answer) => answer.question === index))),
    send: vi.fn(() => true),
    ...overrides,
  }
  return target
}

function fakeComposer(initial = '') {
  let draft = initial
  const target: ComposerTarget = {
    runId: 'r1',
    getDraft: () => draft,
    setDraft: vi.fn((text: string) => {
      draft = text
      return true
    }),
    clearVoiceDraft: vi.fn((text: string) => {
      if (draft === text) draft = ''
      return draft === ''
    }),
    submit: vi.fn(() => {
      draft = ''
      return true
    }),
  }
  return target
}

type AnswerProposal = Extract<VoiceProposal, { kind: 'answer' }>
const answer = (decisionId: string, ...answers: VoiceAnswer[]): AnswerProposal => ({
  kind: 'answer',
  decisionId,
  runId: 'r1',
  askRequestId: 'ask_1',
  answers,
})
const option = (question: number, ...labels: string[]): VoiceAnswer => ({ question, kind: 'option', labels })
const other = (question: number, text: string): VoiceAnswer => ({ question, kind: 'other', text })
const tell = (decisionId: string, text: string): VoiceProposal => ({ kind: 'tell', decisionId, runId: 'r1', text })

describe('voiceStore', () => {
  it('merges answers for the same request', () => {
    const card = fakeCard()
    voiceStore.registerAskCard(card)
    expect(voiceStore.propose(answer('d1', option(0, 'Vitest')))).toEqual({ ok: true })
    expect(voiceStore.propose(answer('d2', other(1, 'use both')))).toEqual({ ok: true, replaced: 'd1' })
    expect(voiceStore.getProposal()).toMatchObject({
      decisionId: 'd2',
      answers: [option(0, 'Vitest'), other(1, 'use both')],
    })
    // A later entry for a question replaces the earlier one; the other question stays.
    expect(voiceStore.propose(answer('d3', option(0, 'Jest')))).toEqual({ ok: true, replaced: 'd2' })
    expect(voiceStore.getProposal()).toMatchObject({
      decisionId: 'd3',
      answers: [option(0, 'Jest'), other(1, 'use both')],
    })
    expect(card.apply).toHaveBeenLastCalledWith([option(0, 'Jest'), other(1, 'use both')])
  })

  it('refuses an answer with no card registered', () => {
    expect(voiceStore.propose(answer('d1', option(0, 'Vitest')))).toEqual({ ok: false, reason: 'no-card' })
    expect(voiceStore.getProposal()).toBeUndefined()
  })

  it('confirm lists unanswered questions and sends nothing', () => {
    const card = fakeCard()
    voiceStore.registerAskCard(card)
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    expect(voiceStore.confirm()).toEqual({ ok: false, unanswered: [{ index: 1, header: 'Build' }] })
    expect(card.send).not.toHaveBeenCalled()
    expect(voiceStore.getProposal()).toBeDefined()
  })

  it('confirm sends when every question is answered', () => {
    const card = fakeCard()
    voiceStore.registerAskCard(card)
    voiceStore.propose(answer('d1', option(0, 'Vitest'), other(1, 'use both')))
    expect(voiceStore.confirm()).toEqual({ ok: true })
    expect(card.send).toHaveBeenCalledTimes(1)
    expect(card.restore).not.toHaveBeenCalled()
    expect(voiceStore.getProposal()).toBeUndefined()
  })

  it('a refused send keeps the proposal, so a later confirm or cancel still works', () => {
    let accept = false
    const card = fakeCard({ send: vi.fn(() => accept) })
    voiceStore.registerAskCard(card)
    voiceStore.propose(answer('d1', option(0, 'Vitest'), other(1, 'use both')))
    expect(voiceStore.confirm()).toEqual({ ok: false, reason: 'busy' })
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
    expect(card.restore).not.toHaveBeenCalled()
    accept = true
    expect(voiceStore.confirm()).toEqual({ ok: true })
    expect(voiceStore.getProposal()).toBeUndefined()
  })

  it('confirm without a proposal has no target', () => {
    expect(voiceStore.confirm()).toEqual({ ok: false, reason: 'no-target' })
  })

  it('cancel restores and clears', () => {
    const card = fakeCard()
    voiceStore.registerAskCard(card)
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    voiceStore.cancel()
    expect(card.restore).toHaveBeenCalledTimes(1)
    expect(voiceStore.getProposal()).toBeUndefined()
    expect(voiceStore.lastDrop()).toBeUndefined()
  })

  it('cancel puts back what the card held before the first answer', () => {
    const before: AskCardValues = { selections: { 0: ['Jest'] }, otherAnswers: {} }
    const card = fakeCard({}, before)
    voiceStore.registerAskCard(card)
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    voiceStore.propose(answer('d2', option(1, 'Vite')))
    expect(card.read).toHaveBeenCalledTimes(1)
    voiceStore.cancel()
    expect(card.restore).toHaveBeenCalledWith(before)
  })

  it('unregistering the card keeps its proposal; the same card registering again gets the answers', () => {
    const before: AskCardValues = { selections: { 0: ['Jest'] }, otherAnswers: {} }
    const unregister = voiceStore.registerAskCard(fakeCard({}, before))
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    const listener = vi.fn()
    voiceStore.subscribe(listener)
    unregister()
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
    expect(voiceStore.lastDrop()).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()

    const again = fakeCard()
    voiceStore.registerAskCard(again)
    expect(again.apply).toHaveBeenCalledWith([option(0, 'Vitest')], { reveal: false })
    expect(again.read).not.toHaveBeenCalled()
    // The next sentence merges with the first; cancel restores the snapshot taken on the first card.
    expect(voiceStore.propose(answer('d2', option(1, 'Vite')))).toEqual({ ok: true, replaced: 'd1' })
    expect(again.apply).toHaveBeenLastCalledWith([option(0, 'Vitest'), option(1, 'Vite')])
    voiceStore.cancel()
    expect(again.restore).toHaveBeenCalledWith(before)
  })

  it('another card registering does not receive the proposal', () => {
    voiceStore.registerAskCard(fakeCard())
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    const other = fakeCard({ requestId: 'ask_2' })
    voiceStore.registerAskCard(other)
    const otherRun = fakeCard({ runId: 'r2' })
    voiceStore.registerAskCard(otherRun)
    expect(other.apply).not.toHaveBeenCalled()
    expect(otherRun.apply).not.toHaveBeenCalled()
  })

  it('confirm while the card is unmounted has no target and keeps the proposal', () => {
    const unregister = voiceStore.registerAskCard(fakeCard())
    voiceStore.propose(answer('d1', option(0, 'Vitest'), other(1, 'use both')))
    unregister()
    expect(voiceStore.confirm()).toEqual({ ok: false, reason: 'no-target' })
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
    const again = fakeCard()
    voiceStore.registerAskCard(again)
    expect(voiceStore.confirm()).toEqual({ ok: true })
    expect(again.send).toHaveBeenCalledTimes(1)
  })

  it('the question settling drops the answer proposal as question-closed', () => {
    const card = fakeCard()
    voiceStore.registerAskCard(card)
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    voiceStore.syncPendingAsk('r1', 'ask_1')
    voiceStore.syncPendingAsk('r2', undefined)
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
    voiceStore.syncPendingAsk('r1', 'ask_2')
    expect(voiceStore.getProposal()).toBeUndefined()
    expect(voiceStore.lastDrop()).toBe('question-closed')
    // The question is gone: nothing is put back on its card.
    expect(card.restore).not.toHaveBeenCalled()

    voiceStore.propose(answer('d2', option(0, 'Vitest')))
    voiceStore.syncPendingAsk('r1', undefined)
    expect(voiceStore.lastDrop()).toBe('question-closed')
  })

  it('leaving the task drops its answer proposal as task-closed', () => {
    voiceStore.registerAskCard(fakeCard())
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    voiceStore.leaveTask('r2')
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
    voiceStore.leaveTask('r1')
    expect(voiceStore.getProposal()).toBeUndefined()
    expect(voiceStore.lastDrop()).toBe('task-closed')
  })

  it('a tell is left to its composer by syncPendingAsk and leaveTask', () => {
    voiceStore.registerComposer(fakeComposer())
    voiceStore.propose(tell('d1', 'hello'))
    voiceStore.syncPendingAsk('r1', undefined)
    voiceStore.leaveTask('r1')
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
  })

  it('pendingAskFor reports the shown question once the thread has synced it', () => {
    const listener = vi.fn()
    voiceStore.subscribe(listener)
    expect(voiceStore.pendingAskFor('r1')).toBeUndefined()
    voiceStore.syncPendingAsk('r1', 'ask_1')
    expect(voiceStore.pendingAskFor('r1')).toBe('ask_1')
    expect(voiceStore.pendingAskFor('r2')).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
    // The same question again changes nothing and wakes nobody.
    voiceStore.syncPendingAsk('r1', 'ask_1')
    expect(listener).toHaveBeenCalledTimes(1)
    voiceStore.syncPendingAsk('r1', undefined)
    expect(voiceStore.pendingAskFor('r1')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    voiceStore.leaveTask('r1')
    expect(voiceStore.pendingAskFor('r1')).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('a new proposal resets the drop reason', () => {
    voiceStore.registerAskCard(fakeCard())
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    voiceStore.leaveTask('r1')
    voiceStore.propose(answer('d2', option(0, 'Vitest')))
    expect(voiceStore.lastDrop()).toBeUndefined()
  })

  it('a card for another request does not receive the proposal', () => {
    voiceStore.registerAskCard(fakeCard({ requestId: 'ask_2' }))
    expect(voiceStore.propose(answer('d1', option(0, 'Vitest')))).toEqual({ ok: false, reason: 'no-card' })
  })

  it('a proposal for another request cancels the current one first', () => {
    const first = fakeCard()
    const second = fakeCard({ requestId: 'ask_2' })
    voiceStore.registerAskCard(first)
    voiceStore.registerAskCard(second)
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    const result = voiceStore.propose({ ...answer('d2', option(0, 'Jest')), askRequestId: 'ask_2' })
    expect(result).toEqual({ ok: true, replaced: 'd1' })
    expect(first.restore).toHaveBeenCalledTimes(1)
    expect(second.apply).toHaveBeenCalledWith([option(0, 'Jest')])
    expect(voiceStore.getProposal()).toMatchObject({ askRequestId: 'ask_2' })
  })

  it('a refused proposal leaves the current one alone', () => {
    const card = fakeCard()
    voiceStore.registerAskCard(card)
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    expect(voiceStore.propose(tell('d2', 'hello'))).toEqual({ ok: false, reason: 'no-card' })
    expect(card.restore).not.toHaveBeenCalled()
    expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
  })

  describe('tell', () => {
    it('is refused when the draft has text', () => {
      const composer = fakeComposer('half a thought')
      voiceStore.registerComposer(composer)
      expect(voiceStore.propose(tell('d1', 'hello'))).toEqual({ ok: false, reason: 'draft-not-empty' })
      expect(composer.setDraft).not.toHaveBeenCalled()
      expect(voiceStore.getProposal()).toBeUndefined()
    })

    it('is refused when no composer is registered for the run', () => {
      expect(voiceStore.propose(tell('d1', 'hello'))).toEqual({ ok: false, reason: 'no-card' })
    })

    it('is refused as busy when the write is blocked, and records nothing', () => {
      const composer = fakeComposer()
      composer.setDraft = vi.fn(() => false)
      voiceStore.registerComposer(composer)
      expect(voiceStore.propose(tell('d1', 'hello'))).toEqual({ ok: false, reason: 'busy' })
      expect(voiceStore.getProposal()).toBeUndefined()
      expect(composer.getDraft()).toBe('')
    })

    it('a blocked tell leaves the current proposal alone', () => {
      const card = fakeCard()
      const composer = fakeComposer()
      composer.setDraft = vi.fn(() => false)
      voiceStore.registerAskCard(card)
      voiceStore.registerComposer(composer)
      voiceStore.propose(answer('d1', option(0, 'Vitest')))
      expect(voiceStore.propose(tell('d2', 'hello'))).toEqual({ ok: false, reason: 'busy' })
      expect(card.restore).not.toHaveBeenCalled()
      expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
    })

    it('a refused submit keeps the tell, its draft and cancel', () => {
      const composer = fakeComposer()
      let accept = false
      composer.submit = vi.fn(() => accept)
      voiceStore.registerComposer(composer)
      voiceStore.propose(tell('d1', 'hello'))
      expect(voiceStore.confirm()).toEqual({ ok: false, reason: 'busy' })
      expect(voiceStore.getProposal()).toMatchObject({ decisionId: 'd1' })
      expect(composer.getDraft()).toBe('hello')
      accept = true
      expect(voiceStore.confirm()).toEqual({ ok: true })
    })

    it('unregistering the composer clears the draft it still holds, but not an edited one', () => {
      const composer = fakeComposer()
      const unregister = voiceStore.registerComposer(composer)
      voiceStore.propose(tell('d1', 'hello'))
      unregister()
      expect(composer.getDraft()).toBe('')
      expect(voiceStore.lastDrop()).toBe('task-closed')

      resetVoiceStoreForTests()
      const edited = fakeComposer()
      const unregisterEdited = voiceStore.registerComposer(edited)
      voiceStore.propose(tell('d2', 'hello'))
      edited.setDraft('hello, and more')
      unregisterEdited()
      expect(edited.getDraft()).toBe('hello, and more')
    })

    it('fills the draft, replaces an earlier tell, and confirms through submit', () => {
      const composer = fakeComposer()
      voiceStore.registerComposer(composer)
      expect(voiceStore.propose(tell('d1', 'hello'))).toEqual({ ok: true })
      expect(composer.getDraft()).toBe('hello')
      expect(voiceStore.propose(tell('d2', 'hello again'))).toEqual({ ok: true, replaced: 'd1' })
      expect(composer.getDraft()).toBe('hello again')
      expect(voiceStore.confirm()).toEqual({ ok: true })
      expect(composer.submit).toHaveBeenCalledTimes(1)
      expect(voiceStore.getProposal()).toBeUndefined()
    })

    it('cancel empties the draft through clearVoiceDraft, which spares an edited one', () => {
      const composer = fakeComposer()
      voiceStore.registerComposer(composer)
      voiceStore.propose(tell('d1', 'hello'))
      voiceStore.cancel()
      expect(composer.clearVoiceDraft).toHaveBeenCalledWith('hello')
      expect(composer.getDraft()).toBe('')
      expect(voiceStore.getProposal()).toBeUndefined()

      voiceStore.propose(tell('d2', 'hello'))
      composer.setDraft('hello, and more')
      voiceStore.cancel()
      expect(composer.getDraft()).toBe('hello, and more')
      expect(voiceStore.getProposal()).toBeUndefined()
    })

    it('cancel empties the draft', () => {
      const composer = fakeComposer()
      voiceStore.registerComposer(composer)
      voiceStore.propose(tell('d1', 'hello'))
      voiceStore.cancel()
      expect(composer.getDraft()).toBe('')
      expect(voiceStore.getProposal()).toBeUndefined()
    })

    it('unregistering the composer drops its proposal', () => {
      const unregister = voiceStore.registerComposer(fakeComposer())
      voiceStore.propose(tell('d1', 'hello'))
      unregister()
      expect(voiceStore.getProposal()).toBeUndefined()
      expect(voiceStore.lastDrop()).toBe('task-closed')
    })

    it('replaces a pending answer proposal after restoring the card', () => {
      const card = fakeCard()
      voiceStore.registerAskCard(card)
      voiceStore.registerComposer(fakeComposer())
      voiceStore.propose(answer('d1', option(0, 'Vitest')))
      expect(voiceStore.propose(tell('d2', 'hello'))).toEqual({ ok: true, replaced: 'd1' })
      expect(card.restore).toHaveBeenCalledTimes(1)
    })
  })

  it('headersFor reads the registered card, and nothing once it is gone', () => {
    expect(voiceStore.headersFor('r1', 'ask_1')).toBeUndefined()
    const unregister = voiceStore.registerAskCard(fakeCard())
    expect(voiceStore.headersFor('r1', 'ask_1')).toEqual(['Library', 'Build'])
    expect(voiceStore.headersFor('r1', 'ask_2')).toBeUndefined()
    unregister()
    expect(voiceStore.headersFor('r1', 'ask_1')).toBeUndefined()
  })

  it('notifies subscribers on every change', () => {
    const listener = vi.fn()
    voiceStore.subscribe(listener)
    voiceStore.registerAskCard(fakeCard())
    voiceStore.propose(answer('d1', option(0, 'Vitest')))
    expect(listener).toHaveBeenCalled()
    listener.mockClear()
    voiceStore.cancel()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
