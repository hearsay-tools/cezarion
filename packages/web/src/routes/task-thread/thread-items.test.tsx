import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import type { RunEvent } from '@open-mercato/cezar-api-client'
import type { UiToolItem } from '@open-mercato/cezar-api-client'

import bashAndScreenshot from '../../../../cezar/src/core/__fixtures__/claude/bash-and-screenshot.expected.json'
import failedAndDenied from '../../../../cezar/src/core/__fixtures__/claude/failed-and-denied.expected.json'
import subagentTask from '../../../../cezar/src/core/__fixtures__/claude/subagent-task.expected.json'
import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import opencodeToolLifecycle from '../../../../cezar/src/core/__fixtures__/opencode/tool-lifecycle.expected.json'
import { groupThreadItems } from './thread-groups'
import {
  ContextGroup,
  isNearBottom,
  OUTPUT_CLAMP_LINES,
  AssistantMessage,
  ProviderAuthRequiredCard,
  ReasoningItem,
  ToolCard,
  ToolStreak,
  UserBubble,
} from './thread-items'
import { reduceThread } from './thread-state'
import { SessionTranscript } from './session-transcript'

afterEach(cleanup)

describe('ProviderAuthRequiredCard', () => {
  it.each([
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
  ] as const)('renders accessible fixed recovery guidance for %s', (provider, label) => {
    render(
      <MemoryRouter initialEntries={['/p/acme/tasks/r1']}>
        <ProviderAuthRequiredCard incident={{
          kind: 'provider-auth-required',
          id: 'v1:2',
          provider,
          authFailureId: 'incident-1',
        }} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('alert').textContent).toContain(`This run needed ${label} authorization`)
    expect(screen.getByRole('alert').textContent).toContain(
      `Review ${label} settings before retrying.`,
    )
    expect(screen.getByRole('alert').textContent).not.toContain(`${label} needs authorization`)
    const link = screen.getByRole('link', { name: 'Open provider settings' })
    expect(link.getAttribute('href')).toBe('/p/acme/settings/agents#providers')
    expect(link.getAttribute('tabindex')).not.toBe('-1')
  })
})

/**
 * The tool cards, driven by REAL items: every fixture item below is pulled verbatim out of the
 * golden `.expected.json` mapper outputs (the exact v2 wire shapes the R2 mappers are pinned
 * to), never hand-invented.
 */

/** The `item` payload of a fixture's `item.*` event, by id + status. */
function goldenItem(events: object[], id: string, status: UiToolItem['status']): UiToolItem {
  for (const event of events as Array<{ item?: UiToolItem }>) {
    if (event.item?.kind === 'tool' && event.item.id === id && event.item.status === status) return event.item
  }
  throw new Error(`no golden tool item ${id} with status ${status}`)
}

const asRunEvents = (events: object[]): RunEvent[] =>
  events.map((event, index) => ({ seq: index + 1, ts: '2026-07-14T12:00:00.000Z', ...event }) as RunEvent)

const card = () => document.querySelector('[data-slot="tool-card"]')!
const trigger = (name: RegExp) => screen.getByRole('button', { name })

describe('ToolCard — states', () => {
  it('running without output: shimmering verb, spinner, locked (disabled trigger, no chevron)', () => {
    const item = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'running')
    render(<ToolCard item={item} />)
    expect(card().getAttribute('data-status')).toBe('running')
    const button = trigger(/Ran.*git status --short/)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.querySelector('.shimmer')?.textContent).toBe('Ran')
    expect(screen.getByRole('status', { name: 'Running' })).toBeTruthy()
    expect(document.querySelector('[data-slot="tool-output"]')).toBeNull()
  })

  it('completed execute: closed by default, expands to the mono output on click', () => {
    const item = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')
    render(<ToolCard item={item} />)
    expect(card().getAttribute('data-status')).toBe('completed')
    const button = trigger(/Ran.*git status --short/)
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(button.querySelector('.shimmer')).toBeNull()
    expect(screen.queryByText(/M src\/example\.ts/)).toBeNull() // closed by default
    fireEvent.click(button)
    expect(document.querySelector('[data-slot="tool-output"] pre')?.textContent).toBe(' M src/example.ts')
    fireEvent.click(button) // the user's toggle wins both ways
    expect(document.querySelector('[data-slot="tool-output"]')).toBeNull()
  })

  it('running execute WITH output: open by default — the live tail is visible while streaming', () => {
    const running = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'running')
    // What the reducer holds mid-stream: the running golden item + accumulated `item.delta{output}`.
    render(<ToolCard item={{ ...running, output: 'npm warn deprecated\n' }} />)
    expect(document.querySelector('[data-slot="tool-output"] pre')?.textContent).toContain('npm warn deprecated')
  })

  it('failed: closed by default with a faint tint; expands to the danger-toned error', () => {
    const item = goldenItem(failedAndDenied, 'toolu_fail_01', 'failed')
    render(<ToolCard item={item} />)
    expect(card().getAttribute('data-status')).toBe('failed')
    // A faint danger tint still identifies it, but the loud outline and auto-open are gone.
    expect(card().className).toContain('border-danger')
    expect(screen.getByText('failed')).toBeTruthy()
    // Calm by default: the red error body only appears once the reader opens the card.
    expect(document.querySelector('[data-slot="tool-error"]')).toBeNull()
    fireEvent.click(trigger(/failed/))
    const error = document.querySelector('[data-slot="tool-error"]')
    expect(error?.textContent).toContain('npm ERR! Missing script: "lint"')
    expect(error?.className).toContain('text-danger')
  })

  it('declined: labeled, and locked when the backend reported no detail', () => {
    const item = goldenItem(failedAndDenied, 'toolu_denied_01', 'declined')
    render(<ToolCard item={item} />)
    expect(card().getAttribute('data-status')).toBe('declined')
    expect(screen.getByText('declined')).toBeTruthy()
    expect((screen.getByRole('button', { name: /declined/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('edit with diffs: old/new render as a tinted unified block inside InlineDiffPreview', () => {
    const item = goldenItem(thinkingEditWriteTodo, 'toolu_01AB', 'completed')
    render(<ToolCard item={item} />)
    fireEvent.click(trigger(/Edit.*\/repo\/src\/middleware\.ts/))
    const preview = document.querySelector('[data-slot="diff-preview"]')!
    expect(preview.textContent).toContain('/repo/src/middleware.ts')
    expect(preview.textContent).toContain("- return redirect('/login')")
    expect(preview.textContent).toContain("+ return redirect('/login', { preserveSession: true })")
  })

  it('a new file (oldText null, the golden Write) renders only added lines', () => {
    const item = goldenItem(thinkingEditWriteTodo, 'toolu_01CD', 'completed')
    render(<ToolCard item={item} />)
    fireEvent.click(trigger(/Write.*\/repo\/src\/middleware\.test\.ts/))
    const preview = document.querySelector('[data-slot="diff-preview"]')!
    expect(preview.textContent).toContain("+ import { test } from 'vitest'")
    expect(preview.textContent).not.toContain('- ')
  })
})

describe('ToolCard — exit-code pill (execute kind)', () => {
  it('exit 0 (the golden opencode bash item) → success pill', () => {
    const item = goldenItem(opencodeToolLifecycle, 'prt_01J8ZE21TOOL', 'completed')
    expect(item.exitCode).toBe(0)
    render(<ToolCard item={item} />)
    const pill = document.querySelector('[data-slot="tool-exit"]')!
    expect(pill.textContent).toBe('0')
    expect(pill.className).toContain('text-success')
  })

  it('a non-zero exit → danger pill', () => {
    const item = goldenItem(opencodeToolLifecycle, 'prt_01J8ZE21TOOL', 'completed')
    render(<ToolCard item={{ ...item, exitCode: 2 }} />)
    const pill = document.querySelector('[data-slot="tool-exit"]')!
    expect(pill.textContent).toBe('2')
    expect(pill.className).toContain('text-danger')
  })

  it('no exit code reported (the golden claude Bash) → no pill invented', () => {
    render(<ToolCard item={goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')} />)
    expect(document.querySelector('[data-slot="tool-exit"]')).toBeNull()
  })
})

describe('ToolCard — long output clamps behind the fade and expands on demand', () => {
  const longOutput = Array.from({ length: OUTPUT_CLAMP_LINES + 8 }, (_, i) => `line ${i + 1}`).join('\n')
  const base = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')

  it('clamps, fades, and offers "Show all N lines"; expanding removes the clamp', () => {
    render(<ToolCard item={{ ...base, output: longOutput }} />)
    fireEvent.click(trigger(/Ran.*git status --short/))
    const output = () => document.querySelector('[data-slot="tool-output"]')!
    expect(output().getAttribute('data-clamped')).toBe('true')
    expect(document.querySelector('[data-slot="tool-output-fade"]')).toBeTruthy()

    const toggle = screen.getByRole('button', { name: `Show all ${OUTPUT_CLAMP_LINES + 8} lines` })
    fireEvent.click(toggle)
    expect(output().getAttribute('data-clamped')).toBeNull()
    expect(document.querySelector('[data-slot="tool-output-fade"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })

  it('short output renders whole — no fade, no toggle', () => {
    render(<ToolCard item={base} />)
    fireEvent.click(trigger(/Ran.*git status --short/))
    expect(document.querySelector('[data-slot="tool-output"]')?.getAttribute('data-clamped')).toBeNull()
    expect(document.querySelector('[data-slot="tool-output-fade"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })
})

describe('isNearBottom — the live-tail stick rule', () => {
  it.each([
    [{ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, true], // empty box sticks
    [{ scrollTop: 780, scrollHeight: 1000, clientHeight: 216 }, true], // at the bottom
    [{ scrollTop: 770, scrollHeight: 1000, clientHeight: 216 }, true], // within the 24px grace
    [{ scrollTop: 400, scrollHeight: 1000, clientHeight: 216 }, false], // reader scrolled up
  ])('%o → %s', (box, expected) => {
    expect(isNearBottom(box)).toBe(expected)
  })
})

describe('ReasoningItem', () => {
  const text = 'The redirect drops the session cookie — the middleware needs to preserve it.'

  it('collapses to a dim "Thinking — {first line}" row; expands to the full text', () => {
    const twoLines = `Orienting on the project structure…\nThen I will read the README.`
    render(<ReasoningItem text={twoLines} />)
    const button = screen.getByRole('button', { name: /Thinking — Orienting on the project structure/ })
    expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain('…')
    expect(screen.queryByText(/Then I will read the README/)).toBeNull()
    fireEvent.click(button)
    expect(screen.getByText(/Then I will read the README/)).toBeTruthy()
  })

  it('a single-line reasoning (the golden fixture text) shows whole with no ellipsis', () => {
    render(<ReasoningItem text={text} />)
    expect(screen.getByRole('button', { name: `Thinking — ${text}` })).toBeTruthy()
    expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain(`Thinking — ${text}`)
  })

  it('renders Markdown in the compact preview and expanded reasoning without nested controls', () => {
    render(<ReasoningItem text={'**Assessing the lock** with `gh api`.\n\n- inspect owner\n- release safely'} />)

    const trigger = screen.getByRole('button', { name: /Thinking — Assessing the lock/ })
    const reasoning = document.querySelector('[data-slot="reasoning"]')!
    expect(reasoning.querySelector('[data-streamdown="strong"]')?.textContent).toBe('Assessing the lock')
    expect(trigger.querySelector('a, button')).toBeNull()
    expect(reasoning.textContent).not.toContain('**')

    fireEvent.click(trigger)
    expect(reasoning.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('gh api')
    expect(reasoning.querySelectorAll('[data-streamdown="list-item"]')).toHaveLength(2)
  })

  // #528 — an empty item must not leave a bare, un-expandable "Thinking —" row.
  it.each([['', 'empty'], ['   ', 'spaces'], ['\n\t ', 'whitespace']])(
    'renders nothing for %s text (%s)',
    (empty) => {
      const { container } = render(<ReasoningItem text={empty} />)
      expect(container.innerHTML).toBe('')
      expect(screen.queryByRole('button')).toBeNull()
    },
  )
})

describe('ContextGroup + ToolStreak', () => {
  it('the group row expands to the individual tool cards', () => {
    const read = goldenItem(subagentTask, 'toolu_sub_01', 'completed') // the golden Grep
    const blocks = groupThreadItems([read, { ...read, id: 'toolu_sub_02' }])
    const group = blocks[0]!
    if (group.kind !== 'context-group') throw new Error('expected a context group')
    render(<ContextGroup group={group} />)
    const button = screen.getByRole('button', { name: 'Explored 2 searches' })
    expect(document.querySelectorAll('[data-slot="tool-card"]')).toHaveLength(0)
    fireEvent.click(button)
    expect(document.querySelectorAll('[data-slot="tool-card"]')).toHaveLength(2)
  })

  it('the streak fold hides its children until toggled', () => {
    render(
      <ToolStreak count={4}>
        <div data-testid="older-card" />
      </ToolStreak>,
    )
    const button = screen.getByRole('button', { name: '4 earlier tool calls' })
    expect(screen.queryByTestId('older-card')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByTestId('older-card')).toBeTruthy()
  })
})

describe('sub-agent nesting (golden subagent-task fixture, end to end through the reducer)', () => {
  it("the Task card's body lists the nested items, indented one level", () => {
    const { turns } = reduceThread(asRunEvents(subagentTask))
    const blocks = groupThreadItems(turns[0]!.items)
    const task = blocks.find((b) => b.kind === 'tool-card')
    if (task?.kind !== 'tool-card') throw new Error('expected the Task card')
    render(
      <SessionTranscript
        runId="r1"
        viewId="main"
        sections={[{ id: 'turn-1', entries: turns[0]!.items }]}
        mode="document"
      />,
    )

    const button = screen.getByRole('button', { name: /Task/ })
    expect((button as HTMLButtonElement).disabled).toBe(false) // nested children ARE detail — the card is not locked
    fireEvent.click(button)
    const nested = document.querySelector('[data-slot="tool-nested"]')!
    expect(nested.querySelector('[data-slot="assistant-message"]')?.textContent).toContain('Scanning the auth middleware')
    expect(nested.querySelectorAll('[data-slot="tool-card"]')).toHaveLength(1)
  })
})


/**
 * #950 — images and files share one list of URLs on the record, so the bubble has to tell them
 * apart by the persisted NAME. Rendering a `.pdf` in an `<img>` is what the user would see as a
 * broken attachment, on the one screen that is supposed to show them their own message back.
 */
describe('conversation message surfaces', () => {
  it('labels user and agent messages with the shared role surface', () => {
    render(
      <MemoryRouter>
        <UserBubble text="Summarize what this project does." />
        <AssistantMessage text="The answer is 42." />
      </MemoryRouter>,
    )

    const user = document.querySelector('[data-slot="user-bubble"]')
    const agent = document.querySelector('[data-slot="assistant-message"]')
    expect(user?.getAttribute('data-role')).toBe('user')
    expect(agent?.getAttribute('data-role')).toBe('agent')
    expect(user?.querySelector(':scope > p')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('YOUR MESSAGE')
    expect(agent?.querySelector(':scope > p')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('AGENT RESPONSE')
    expect(document.querySelector('[data-slot="note-line"]')).toBeNull()
    expect(document.querySelector('[data-slot="tool-card"]')).toBeNull()
    expect(document.querySelector('[data-slot="reasoning"]')).toBeNull()
  })

  it('does not infer badges, CTAs, or success styling from message contents', async () => {
    render(
      <MemoryRouter>
        <AssistantMessage text="CI and review passed on https://github.com/hearsay-tools/cezarion/pull/244" />
        <AssistantMessage text="Pre-flight passed. Creating the branch, assigning the issue, and adding it to the board." />
        <AssistantMessage text="The answer is 42." />
      </MemoryRouter>,
    )

    const surfaces = [...document.querySelectorAll('[data-slot="assistant-message"]')]
    await waitFor(() => {
      expect(surfaces[0]?.textContent).toContain('CI and review passed')
    })
    for (const surface of surfaces) {
      expect(surface.getAttribute('data-role')).toBe('agent')
      expect(surface.querySelector('[role="status"]')).toBeNull()
      expect(surface.querySelector('[data-slot="badge"]')).toBeNull()
      expect(surface.className).not.toMatch(/\bsuccess\b/)
    }
    expect(surfaces[2]?.textContent).toContain('The answer is 42.')
    expect(surfaces[0]?.textContent).toContain('https://github.com/hearsay-tools/cezarion/pull/244')
    expect(screen.queryByRole('button', { name: /passed|success|view pull request/i })).toBeNull()
  })

  it('keeps thinking, tool calls, and lifecycle notes off the role surface', () => {
    render(
      <MemoryRouter>
        <SessionTranscript
          runId="r1"
          viewId="main"
          sections={[{
            id: 'turn-1',
            entries: [
              { kind: 'reasoning', id: 'r', text: 'Considering the layout…' },
              { kind: 'note', id: 'n', text: 'worktree ready', tone: 'dim' },
            ],
          }]}
          mode="document"
        />
      </MemoryRouter>,
    )

    expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain('Considering the layout')
    expect(document.querySelector('[data-slot="note-line"]')?.textContent).toContain('worktree ready')
    expect(document.querySelector('[data-slot="user-bubble"]')).toBeNull()
    expect(document.querySelector('[data-slot="assistant-message"]')).toBeNull()
    expect(document.body.textContent).not.toContain('YOUR MESSAGE')
    expect(document.body.textContent).not.toContain('AGENT RESPONSE')
  })
})

const MESSAGE_COLOR_TOKENS = [
  'message-user-bg',
  'message-user-border',
  'message-user-accent',
  'message-agent-bg',
  'message-agent-border',
  'message-agent-accent',
] as const

const WORKER_MESSAGE_COLOR_TOKENS = [
  'message-outbound-bg',
  'message-outbound-border',
  'message-outbound-accent',
  'message-inbound-bg',
  'message-inbound-border',
  'message-inbound-accent',
] as const

describe('message color tokens', () => {
  it('defines six message color tokens for light and dark', () => {
    const css = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'),
      'utf8',
    )
    const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('.light {'))
    const lightBlock = css.slice(css.indexOf('.light {'), css.indexOf('@theme'))
    for (const token of MESSAGE_COLOR_TOKENS) {
      expect(rootBlock).toContain(`--${token}:`)
      expect(lightBlock).toContain(`--${token}:`)
      expect(css).toContain(`--color-${token}: var(--${token})`)
    }
  })

  it('defines inbound and outbound worker conversation tokens for light and dark', () => {
    const css = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'),
      'utf8',
    )
    const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('.light {'))
    const lightBlock = css.slice(css.indexOf('.light {'), css.indexOf('@theme'))
    for (const token of WORKER_MESSAGE_COLOR_TOKENS) {
      expect(rootBlock).toContain(`--${token}:`)
      expect(lightBlock).toContain(`--${token}:`)
      expect(css).toContain(`--color-${token}: var(--${token})`)
    }
    // Reference screenshot: blue sends, purple receives, never human-message amber.
    for (const block of [rootBlock, lightBlock]) {
      const rgb = (role: string) => {
        const hex = block.match(new RegExp(`--message-${role}-bg: #([0-9a-f]{6})`))![1]!
        return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number]
      }
      const [sendR, sendG, sendB] = rgb('outbound')
      const [receiveR, receiveG, receiveB] = rgb('inbound')
      expect(sendB).toBeGreaterThan(sendG)
      expect(sendG).toBeGreaterThan(sendR)
      expect(receiveB).toBeGreaterThan(receiveR)
      expect(receiveR).toBeGreaterThan(receiveG)
    }
  })
})

describe('UserBubble attachments', () => {
  it.each(['pdf', 'txt', 'md'])('scopes a %s download to the active non-boot project', (extension) => {
    setApiScope('second-project')
    try {
      render(<MemoryRouter><UserBubble text="brief" images={[`/api/v1/runs/r1/images/pasted-1.${extension}`]} /></MemoryRouter>)
      expect(screen.getByText(`pasted-1.${extension}`).closest('a')?.getAttribute('href'))
        .toBe(`/api/v1/p/second-project/runs/r1/images/pasted-1.${extension}`)
    } finally {
      setApiScope(null)
    }
  })

  it('shows an image inline and a file as a download chip', () => {
    render(
      <MemoryRouter>
        <UserBubble
          text="read the brief"
          imageCount={2}
          images={['/api/v1/runs/r1/images/pasted-1.png', '/api/v1/runs/r1/images/pasted-2.pdf']}
        />
      </MemoryRouter>,
    )
    const img = screen.getByAltText('attached') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v1/runs/r1/images/pasted-1.png')
    const chip = screen.getByText('pasted-2.pdf').closest('a') as HTMLAnchorElement
    expect(chip.getAttribute('href')).toBe('/api/v1/runs/r1/images/pasted-2.pdf')
    expect(chip.hasAttribute('download')).toBe(true)
    // The file must not have been rendered as an image anywhere.
    expect(screen.queryAllByAltText('attached')).toHaveLength(1)
  })

  it('renders a .md and a .txt as chips too', () => {
    render(
      <MemoryRouter>
        <UserBubble
          text="two briefs"
          imageCount={2}
          images={['/api/v1/runs/r1/images/pasted-1.md', '/api/v1/runs/r1/images/pasted-2.txt']}
        />
      </MemoryRouter>,
    )
    expect(screen.queryAllByAltText('attached')).toHaveLength(0)
    expect(screen.getByText('pasted-1.md')).toBeTruthy()
    expect(screen.getByText('pasted-2.txt')).toBeTruthy()
  })
})


describe('parent/worker conversation transcript', () => {
  it('deduplicates replay, links both participants and preserves a human ask', () => {
    const senderRunId = '11111111-1111-4111-8111-111111111111', recipientRunId = '22222222-2222-4222-8222-222222222222', id = '33333333-3333-4333-8333-333333333333';
    const message = { id, senderRunId, recipientRunId, kind: 'request', text: 'Please inspect the parser', createdAt: '2026-09-08T12:00:00.000Z', requestHash: 'a'.repeat(64), state: 'accepted' };
    const outcome = { requestId: id, status: 'replied', observedAt: message.createdAt };
    const events = asRunEvents([{ type: 'ask.requested', requestId: 'human', questions: [{ header: 'Proceed?', question: 'Proceed?', options: [] }] }, { type: 'conversation-message', message, delivery: 'queued' }, { type: 'conversation-message', message, delivery: 'queued' }, { type: 'request-outcome', outcome }, { type: 'request-outcome', outcome }]);
    const state = reduceThread(events);
    const entries = state.turns.flatMap(turn => turn.items);
    expect(entries.filter(entry => entry.kind === 'conversation')).toHaveLength(1);
    expect(entries.filter(entry => entry.kind === 'note')).toHaveLength(0);
    expect(entries.find(entry => entry.kind === 'ask')).toMatchObject({ resolved: false });
    render(<MemoryRouter initialEntries={['/p/acme/tasks/current']}><SessionTranscript runId={senderRunId} viewId="main" sections={[{ id: 'conversation', entries }]} mode="document" taskTitles={{ [senderRunId]: 'Parent', [recipientRunId]: 'Alpha' }} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'SENT to Alpha' }).getAttribute('href')).toBe(`/p/acme/tasks/${recipientRunId}`);
    expect(screen.getByText(/Please inspect the parser/)).toBeTruthy();
    expect(screen.getByText('Replied')).toBeTruthy();
    expect(screen.getByText('Request')).toBeTruthy();
    expect(screen.queryByText(/Request outcome:/)).toBeNull();
    expect(document.body.textContent).not.toContain(senderRunId);
    expect(document.body.textContent).not.toContain(recipientRunId);
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText(id, { exact: false })).toBeTruthy();
    expect(screen.getByText(/Queued/)).toBeTruthy();
  });

  it('batches adjacent sends but preserves delayed replies as independent inbound cards', () => {
    const parent = '11111111-1111-4111-8111-111111111111'
    const alpha = '22222222-2222-4222-8222-222222222222'
    const bravo = '55555555-5555-4555-8555-555555555555'
    const reqA = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', senderRunId: parent, recipientRunId: alpha, kind: 'request', text: 'Ping both workers', createdAt: '2026-09-08T12:00:00.000Z', requestHash: 'a'.repeat(64), state: 'accepted' }
    const reqB = { ...reqA, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', recipientRunId: bravo }
    const reply = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', senderRunId: alpha, recipientRunId: parent, kind: 'reply', requestId: reqA.id, text: 'Got it — Alpha pong', createdAt: '2026-09-08T12:01:00.000Z', requestHash: 'b'.repeat(64), state: 'accepted' }
    const events = asRunEvents([
      { type: 'conversation-message', message: reqA, delivery: 'delivered' },
      { type: 'conversation-message', message: reqB, delivery: 'delivered' },
      { type: 'note', message: 'Continuing independent work while Alpha responds' },
      { type: 'request-outcome', outcome: { requestId: reqA.id, status: 'replied', observedAt: reply.createdAt, replyId: reply.id } },
      { type: 'conversation-message', message: reply, delivery: 'delivered' },
    ])
    const entries = reduceThread(events).turns.flatMap(turn => turn.items)
    render(
      <MemoryRouter initialEntries={['/p/acme/tasks/current']}>
        <main data-slot="main">
          <SessionTranscript runId={parent} viewId="main" sections={[
            { id: 'send-turn', entries: entries.slice(0, -1) },
            { id: 'reply-turn', entries: entries.slice(-1) },
          ]} mode="document" taskTitles={{ [parent]: 'Parent', [alpha]: 'Alpha', [bravo]: 'Bravo' }} />
        </main>
      </MemoryRouter>,
    )
    expect(document.querySelectorAll('[data-slot="worker-conversation-card"]')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'SENT to Alpha' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Alpha — Replied' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'SENT to Bravo' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Bravo — Pending' })).toBeTruthy()
    expect(screen.getByText('Got it — Alpha pong')).toBeTruthy()
    expect(document.querySelector('[data-direction="inbound"]')?.textContent).toContain('Got it — Alpha pong')
    expect(document.querySelector('[data-direction="outbound"]')?.textContent).not.toContain('Got it — Alpha pong')
    expect(screen.getByRole('button', { name: 'View request to Alpha' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View reply from Alpha' })).toBeTruthy()
    const rows = [...document.querySelectorAll('[data-slot="thread-row"]')]
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('Ping both workers')
    expect(rows[1]?.textContent).toContain('Continuing independent work')
    expect(rows[2]?.textContent).toContain('Got it — Alpha pong')
    fireEvent.click(screen.getByRole('button', { name: 'View request to Alpha' }))
    expect(document.activeElement).toBe(rows[0])
    fireEvent.click(screen.getByRole('button', { name: 'View reply from Alpha' }))
    expect(document.activeElement).toBe(rows[2])
  })

  it.each(['timed-out', 'cancelled'])('links a late reply without rewriting a %s outcome', (status) => {
    const parent = '11111111-1111-4111-8111-111111111111'
    const alpha = '22222222-2222-4222-8222-222222222222'
    const request = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', senderRunId: parent, recipientRunId: alpha,
      kind: 'request', text: 'Inspect', createdAt: '2026-09-20T12:00:00Z', requestHash: 'a'.repeat(64), state: 'accepted' }
    const reply = { ...request, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', senderRunId: alpha, recipientRunId: parent,
      kind: 'reply', requestId: request.id, text: 'Late answer' }
    const entries = reduceThread(asRunEvents([
      { type: 'conversation-message', message: request, delivery: 'delivered' },
      { type: 'request-outcome', outcome: { requestId: request.id, status, observedAt: request.createdAt } },
      { type: 'conversation-message', message: reply, delivery: 'delivered' },
    ])).turns.flatMap(turn => turn.items)
    render(<MemoryRouter><SessionTranscript runId={parent} viewId="main" sections={[{ id: 'turn', entries }]}
      mode="document" taskTitles={{ [alpha]: 'Alpha' }} /></MemoryRouter>)
    expect(screen.getByRole('button', { name: 'View reply from Alpha' })).toBeTruthy()
    expect(screen.getByText(status === 'timed-out' ? 'Timed out' : 'Cancelled')).toBeTruthy()
    expect(screen.queryByText('Replied')).toBeNull()
  })

  it('does not offer a broken request link when only the reply is loaded', () => {
    const entries = reduceThread(asRunEvents([
      { type: 'conversation-message', delivery: 'delivered', message: {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', senderRunId: '22222222-2222-4222-8222-222222222222',
        recipientRunId: '11111111-1111-4111-8111-111111111111', kind: 'reply',
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'Delayed response',
        createdAt: '2026-09-20T12:05:00Z', requestHash: 'a'.repeat(64), state: 'accepted',
      } },
    ])).turns.flatMap(turn => turn.items)
    render(<MemoryRouter><SessionTranscript runId="11111111-1111-4111-8111-111111111111" viewId="main"
      sections={[{ id: 'tail', entries }]} mode="document" /></MemoryRouter>)
    expect(screen.getByText('Linked request is outside loaded history.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /View request/ })).toBeNull()
    expect(screen.getByText('Delayed response')).toBeTruthy()
  })

  // A recipient under review or already destroyed never receives the request, so the card
  // reports that terminal delivery rather than a reply that will never come.
  it('reports an undelivered request as not delivered instead of pending', () => {
    const parent = '11111111-1111-4111-8111-111111111111'
    const alpha = '22222222-2222-4222-8222-222222222222'
    const request = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', senderRunId: parent, recipientRunId: alpha, kind: 'request', text: 'Ping the parked worker', createdAt: '2026-09-08T12:00:00.000Z', requestHash: 'a'.repeat(64), state: 'continuation-required' }
    const entries = reduceThread(asRunEvents([
      { type: 'conversation-message', message: request, delivery: 'not-delivered' },
    ])).turns.flatMap(turn => turn.items)
    render(
      <MemoryRouter initialEntries={['/p/acme/tasks/current']}>
        <SessionTranscript runId={parent} viewId="main" sections={[{ id: 'conversation', entries }]} mode="document" taskTitles={{ [parent]: 'Parent', [alpha]: 'Alpha' }} />
      </MemoryRouter>,
    )
    expect(screen.queryByText('Pending')).toBeNull()
    expect(document.querySelector('[data-slot="conversation-outcome"]')?.textContent).toBe('Not delivered')
  })
});


describe('conversation delivery replay', () => {
  it.each([false, true])('merges delivery ACK and stale projection in either order (ACK first: %s)', ackFirst => {
    const id = '33333333-3333-4333-8333-333333333333', senderRunId = '11111111-1111-4111-8111-111111111111', recipientRunId = '22222222-2222-4222-8222-222222222222';
    const attribution = { senderRunId, recipientRunId, kind: 'progress' };
    const message = { id, ...attribution, text: 'Updated', createdAt: '2026-09-08T12:00:00.000Z', requestHash: 'a'.repeat(64), state: 'accepted' };
    const projection = { type: 'conversation-message', message, delivery: 'queued' };
    const ack = { type: 'agent-input', input: { id, source: 'agent', parentRunId: senderRunId, text: message.text, createdAt: message.createdAt, deliveredAt: message.createdAt, conversation: attribution } };
    const entries = reduceThread(asRunEvents(ackFirst ? [ack, projection, ack] : [projection, ack, projection])).turns.flatMap(turn => turn.items);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'conversation', delivery: 'delivered', senderRunId, recipientRunId });
    const senderEntries = reduceThread(asRunEvents([projection, { ...projection, delivery: 'delivered' }, projection])).turns.flatMap(turn => turn.items);
    expect(senderEntries).toHaveLength(1);
    expect(senderEntries[0]).toMatchObject({ kind: 'conversation', delivery: 'delivered' });
  });
});
