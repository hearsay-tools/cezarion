import type { VoiceAnswer, VoicePosition, VoiceStatus } from '@open-mercato/cezar-api-client'

/**
 * How the palette's voice rows and notices say a position and a status (spec
 * 2026-10-21-voice-mode, § Open by status and position). Every row and every notice reads these,
 * so "No third failed task." and "Open “…” — next waiting for CI" use the same words.
 */

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']

/** `next`, `previous`, `last`, or `first` … `tenth` for a number. */
export function positionWords(position: VoicePosition): string {
  return typeof position === 'number' ? (ORDINALS[position - 1] ?? String(position)) : position
}

/** The status id read aloud: `-` as a space and `ci` as `CI` (`waiting for CI`, `needs you`). */
export function statusWords(status: VoiceStatus): string {
  return status
    .split('-')
    .map((word) => (word === 'ci' ? 'CI' : word))
    .join(' ')
}

/** `Open “<title>” — <position> <status>`. */
export function openRowText(title: string, status: VoiceStatus, position: VoicePosition): string {
  return `Open “${title}” — ${positionWords(position)} ${statusWords(status)}`
}

export const noTasksNotice = (status: VoiceStatus): string => `No ${statusWords(status)} tasks.`

export const pastEndNotice = (status: VoiceStatus, position: VoicePosition): string =>
  `No ${positionWords(position)} ${statusWords(status)} task.`

/** `Answer “<task>”: <header>: <labels or Other text>`, one `<header>: <value>` entry per question,
 *  joined with `; `. Without a known task title it reads `Answer <header>: …`. A card the palette
 *  cannot see (`headers` undefined) is named by its 1-based question number. */
export function answerRowText(
  answers: readonly VoiceAnswer[],
  headers: readonly string[] | undefined,
  taskTitle?: string,
): string {
  return `Answer ${taskTitle ? `“${taskTitle}”: ` : ''}${answerLines(answers, headers).join('; ')}`
}

/** One `<header>: <labels or Other text>` entry per answered question. */
export function answerLines(answers: readonly VoiceAnswer[], headers: readonly string[] | undefined): string[] {
  return answers.map((answer) => {
    const header = headers?.[answer.question] || `question ${answer.question + 1}`
    const value = answer.kind === 'option' ? answer.labels.join(', ') : answer.text
    return `${header}: ${value}`
  })
}

/** The confirmation panel's heading: `Answer “<task>”` or `Send to “<task>”`, with a fallback
 *  when the palette does not know the task's title. */
export function confirmHeading(kind: 'answer' | 'tell', taskTitle?: string): string {
  if (kind === 'answer') return taskTitle ? `Answer “${taskTitle}”` : 'Answer the question'
  return taskTitle ? `Send to “${taskTitle}”` : 'Send to this task'
}

/** `Tell “<task>”: <text>`, or `Tell it: <text>` without a known task title. */
export const tellRowText = (text: string, taskTitle?: string): string =>
  taskTitle ? `Tell “${taskTitle}”: ${text}` : `Tell it: ${text}`
