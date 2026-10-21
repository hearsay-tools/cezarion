import { useSyncExternalStore } from 'react'

import type { VoiceAnswer } from '@open-mercato/cezar-api-client'

/**
 * The browser-side voice proposal (spec 2026-10-21-voice-mode, § Confirmation): what the palette
 * decided, shown on the open question card or in the composer until the user confirms, cancels,
 * replaces it or leaves. Nothing here sends on its own. A module singleton, because the palette
 * and the card are far apart in the tree and both live as long as the page.
 */

export type VoiceProposal =
  | { kind: 'answer'; decisionId: string; runId: string; askRequestId: string; answers: VoiceAnswer[] }
  | { kind: 'tell'; decisionId: string; runId: string; text: string }

/** What an open question card lets the store do. Every method reads the card's latest state. */
export interface AskCardTarget {
  runId: string
  requestId: string
  headers: string[]
  apply(answers: VoiceAnswer[]): void
  restore(): void
  unanswered(): number[]
  send(): void
}

/** What a thread composer lets the store do. */
export interface ComposerTarget {
  runId: string
  getDraft(): string
  setDraft(text: string): void
  submit(): void
}

export type ProposeResult = { ok: true; replaced?: string } | { ok: false; reason: 'no-card' | 'draft-not-empty' }
export type ConfirmResult =
  | { ok: true }
  | { ok: false; unanswered: { index: number; header: string }[] }
  | { ok: false; reason: 'no-target' }

type DropReason = 'question-closed' | 'task-closed'

let proposal: VoiceProposal | undefined
let drop: DropReason | undefined
const cards = new Map<string, AskCardTarget>()
const composers = new Map<string, ComposerTarget>()
const listeners = new Set<() => void>()

const cardKey = (runId: string, requestId: string) => `${runId}\u0000${requestId}`
const notify = () => listeners.forEach((listener) => listener())

const cardFor = (p: Extract<VoiceProposal, { kind: 'answer' }>) => cards.get(cardKey(p.runId, p.askRequestId))

/** Undo what a proposal put on screen: the card goes back to its snapshot, the draft is emptied. */
function undo(p: VoiceProposal) {
  if (p.kind === 'answer') cardFor(p)?.restore()
  else composers.get(p.runId)?.setDraft('')
}

/** Later entries for a question replace earlier ones; the result is in question order. */
function mergeAnswers(current: VoiceAnswer[], next: VoiceAnswer[]): VoiceAnswer[] {
  const byQuestion = new Map<number, VoiceAnswer>()
  for (const entry of [...current, ...next]) byQuestion.set(entry.question, entry)
  return [...byQuestion.values()].sort((a, b) => a.question - b.question)
}

function propose(next: VoiceProposal): ProposeResult {
  const current = proposal
  if (next.kind === 'answer') {
    const card = cardFor(next)
    if (!card) return { ok: false, reason: 'no-card' }
    if (current?.kind === 'answer' && current.askRequestId === next.askRequestId && current.runId === next.runId) {
      const merged: VoiceProposal = { ...next, answers: mergeAnswers(current.answers, next.answers) }
      proposal = merged
      drop = undefined
      card.apply(merged.answers)
      notify()
      return { ok: true, replaced: current.decisionId }
    }
    if (current) undo(current)
    proposal = next
    drop = undefined
    card.apply(next.answers)
    notify()
    return current ? { ok: true, replaced: current.decisionId } : { ok: true }
  }
  const composer = composers.get(next.runId)
  if (!composer) return { ok: false, reason: 'no-card' }
  // A new tell may overwrite the draft only when that draft is the previous tell, untouched.
  const draft = composer.getDraft()
  const replacesTell = current?.kind === 'tell' && current.runId === next.runId && draft === current.text
  if (draft.trim() !== '' && !replacesTell) return { ok: false, reason: 'draft-not-empty' }
  if (current && !replacesTell) undo(current)
  proposal = next
  drop = undefined
  composer.setDraft(next.text)
  notify()
  return current ? { ok: true, replaced: current.decisionId } : { ok: true }
}

function confirmProposal(): ConfirmResult {
  const current = proposal
  if (!current) return { ok: false, reason: 'no-target' }
  if (current.kind === 'answer') {
    const card = cardFor(current)
    if (!card) return { ok: false, reason: 'no-target' }
    const missing = card.unanswered()
    if (missing.length > 0) {
      return { ok: false, unanswered: missing.map((index) => ({ index, header: card.headers[index] ?? '' })) }
    }
    card.send()
  } else {
    const composer = composers.get(current.runId)
    if (!composer) return { ok: false, reason: 'no-target' }
    composer.submit()
  }
  proposal = undefined
  notify()
  return { ok: true }
}

function cancel() {
  const current = proposal
  if (!current) return
  undo(current)
  proposal = undefined
  notify()
}

/** The proposal's target went away: nothing to restore, only to forget and say why. */
function dropProposal(reason: DropReason) {
  proposal = undefined
  drop = reason
  notify()
}

export const voiceStore = {
  getProposal: (): VoiceProposal | undefined => proposal,
  propose,
  confirm: confirmProposal,
  cancel,
  /** Why the last proposal ended without the user. */
  lastDrop: (): DropReason | undefined => drop,
  registerAskCard(target: AskCardTarget): () => void {
    const key = cardKey(target.runId, target.requestId)
    cards.set(key, target)
    return () => {
      if (cards.get(key) !== target) return
      cards.delete(key)
      if (proposal?.kind === 'answer' && cardKey(proposal.runId, proposal.askRequestId) === key) {
        dropProposal('question-closed')
      }
    }
  },
  registerComposer(target: ComposerTarget): () => void {
    composers.set(target.runId, target)
    return () => {
      if (composers.get(target.runId) !== target) return
      composers.delete(target.runId)
      if (proposal?.kind === 'tell' && proposal.runId === target.runId) dropProposal('task-closed')
    }
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

export function useVoiceProposal(): VoiceProposal | undefined {
  return useSyncExternalStore(voiceStore.subscribe, voiceStore.getProposal, voiceStore.getProposal)
}

/** Test-only: the store is a module singleton, so each case starts from an empty one. */
export function resetVoiceStoreForTests() {
  proposal = undefined
  drop = undefined
  cards.clear()
  composers.clear()
  listeners.clear()
}
