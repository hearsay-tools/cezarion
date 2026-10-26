import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { toolDisplay } from '@open-mercato/cezar-api-client/contract/tool-display'
import type { UiToolItem } from '@open-mercato/cezar-api-client'

import bashAndScreenshot from '../../../../cezar/src/core/__fixtures__/claude/bash-and-screenshot.expected.json'
import commandLifecycle from '../../../../cezar/src/core/__fixtures__/codex/command-lifecycle.expected.json'
import { ToolCard } from './thread-items'

afterEach(cleanup)

function goldenItem(events: object[], id: string, status: UiToolItem['status']): UiToolItem {
  for (const event of events as Array<{ item?: UiToolItem }>) {
    if (event.item?.kind === 'tool' && event.item.id === id && event.item.status === status) {
      return event.item
    }
  }
  throw new Error(`no golden tool item ${id} with status ${status}`)
}

describe('ToolCard expanded exec command from input', () => {
  it('expands a command longer than 120 characters including its last argument', () => {
    const tail = '--unique-final-flag-that-truncation-must-not-hide'
    const segment = 'very-long-project-path-segment/'
    const command = `cd /home/agent/projects/${segment.repeat(6)} && npm run typecheck ${tail}`
    const base = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')
    const item: UiToolItem = {
      ...base,
      title: toolDisplay('Bash', { command }).title,
      input: { command },
      output: undefined,
    }
    render(<ToolCard item={item} />)
    const button = screen.getByRole('button', { name: /Ran/ })
    expect(button.querySelector('code')?.textContent).not.toContain(tail)
    fireEvent.click(button)
    const expanded = document.querySelector('[data-slot="tool-command"]')
    expect(expanded?.textContent).toBe(command)
    expect(expanded?.className).toContain('whitespace-pre-wrap')
    expect(expanded?.className).toContain('break-words')
    expect(expanded?.className).toContain('[overflow-wrap:anywhere]')
  })

  it('preserves multiline string commands and shell operators', () => {
    const command = ['cat', 'hello world && echo HOME', 'done'].join('\n')
    const base = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')
    const item: UiToolItem = {
      ...base,
      title: toolDisplay('Bash', { command }).title,
      input: { command },
      output: undefined,
    }
    render(<ToolCard item={item} />)
    fireEvent.click(screen.getByRole('button', { name: /Ran/ }))
    expect(document.querySelector('[data-slot="tool-command"]')?.textContent).toBe(command)
  })

  it('keeps argv argument boundaries when expanded', () => {
    const tail = '--unique-final-flag-that-truncation-must-not-hide'
    const spaced = 'hello world'
    const argv = ['printf', '%s\\n', spaced, tail]
    const base = goldenItem(commandLifecycle, 'item_cmd_1', 'completed')
    const item: UiToolItem = {
      ...base,
      title: toolDisplay('commandExecution', { command: argv }).title,
      input: { command: argv },
      output: undefined,
    }
    render(<ToolCard item={item} />)
    fireEvent.click(screen.getByRole('button', { name: /Ran/ }))
    const text = document.querySelector('[data-slot="tool-command"]')?.textContent ?? ''
    expect(text).toContain(tail)
    expect(text).toContain('printf')
    expect(text.includes(spaced)).toBe(true)
    expect(text.includes(`\u0027${spaced}\u0027`) || text.includes(`\u0022${spaced}\u0022`)).toBe(true)
  })

  it.each(['running', 'completed', 'failed'] as const)('exposes the command on a %s exec item', (status) => {
    const tail = '--unique-final-flag-that-truncation-must-not-hide'
    const segment = 'very-long-project-path-segment/'
    const command = `cd /home/agent/projects/${segment.repeat(6)} && npm run typecheck ${tail}`
    const base = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')
    const item: UiToolItem = {
      ...base,
      title: toolDisplay('Bash', { command }).title,
      input: { command },
      status,
      output: undefined,
      error: status === 'failed' ? 'exit 1' : undefined,
    }
    render(<ToolCard item={item} />)
    fireEvent.click(screen.getByRole('button', { name: /Ran/ }))
    expect(document.querySelector('[data-slot="tool-command"]')?.textContent).toBe(command)
  })

  it('exposes a silent completed command with no output', () => {
    const tail = '--unique-final-flag-that-truncation-must-not-hide'
    const segment = 'very-long-project-path-segment/'
    const command = `cd /home/agent/projects/${segment.repeat(6)} && npm run typecheck ${tail}`
    const base = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')
    const item: UiToolItem = {
      ...base,
      title: toolDisplay('Bash', { command }).title,
      input: { command },
      output: undefined,
    }
    render(<ToolCard item={item} />)
    expect(document.querySelector('[data-slot="tool-command"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Ran/ }))
    expect(document.querySelector('[data-slot="tool-command"]')?.textContent).toBe(command)
    expect(document.querySelector('[data-slot="tool-output"]')).toBeNull()
  })

  it('keeps collapsed summaries compact', () => {
    const tail = '--unique-final-flag-that-truncation-must-not-hide'
    const segment = 'very-long-project-path-segment/'
    const command = `cd /home/agent/projects/${segment.repeat(6)} && npm run typecheck ${tail}`
    const base = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')
    const item: UiToolItem = {
      ...base,
      title: toolDisplay('Bash', { command }).title,
      input: { command },
      output: undefined,
    }
    render(<ToolCard item={item} />)
    const code = screen.getByRole('button', { name: /Ran/ }).querySelector('code')
    expect(code?.className).toContain('truncate')
    expect(code?.textContent).toContain('\u2026')
    expect(code?.textContent).not.toContain(tail)
  })

  it('falls back to the title for historical items without command input', () => {
    const base = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')
    const historical = { ...base }
    delete historical.input
    render(<ToolCard item={historical} />)
    fireEvent.click(screen.getByRole('button', { name: /Ran.*git status --short/ }))
    expect(document.querySelector('[data-slot="tool-command"]')?.textContent).toBe('git status --short')
  })
})
