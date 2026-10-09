import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ReferenceList } from './reference-overflow'

beforeAll(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }))
afterEach(cleanup)
const references = [812, 813, 814, 815, 816].map(number => ({ kind: 'PR' as const, number, url: `https://github.com/o/r/pull/${number}` }))
const list = (maxVisible = 2) => render(<MemoryRouter><ReferenceList references={references} maxVisible={maxVisible} taskTitle="Split work" projectId="other-project" runId="run" repoBase="https://github.com/o/r" plain compact /></MemoryRouter>)

describe('shared reference overflow', () => {
  it('restores the last inline reference when removing overflow frees enough space', async () => {
    let rowWidth = 100
    const observers: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observers.push(callback) }
      observe() {} unobserve() {} disconnect() {}
    })
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const slot = this.getAttribute('data-slot')
      const overflowWidth = document.querySelector('[data-slot="fit-overflow"] button') ? 50 : 0
      const left = slot === 'reference-list' ? 70 : 0
      const width = slot === 'fit-line' ? rowWidth - overflowWidth : slot === 'fit-overflow' ? overflowWidth : 50
      return { left, right: left + width, width, top: 0, bottom: 16, height: 16, x: left, y: 0, toJSON() {} }
    })
    function FittingRow() {
      const [overflow, setOverflow] = useState<HTMLSpanElement | null>(null)
      return <><span data-slot="fit-line"><ReferenceList references={references.slice(0, 1)} maxVisible={2}
        taskTitle="Split work" runId="run" plain compact fitContainer overflowContainer={overflow} /></span>
        <span data-slot="fit-overflow" ref={setOverflow} /></>
    }
    try {
      const { container } = render(<MemoryRouter><FittingRow /></MemoryRouter>)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Show all 1 references for Split work' })).toBeTruthy())
      rowWidth = 150
      act(() => observers.forEach(callback => callback()))
      await waitFor(() => expect(container.querySelectorAll('[data-slot="pr-chip"]')).toHaveLength(1))
      expect(container.querySelector('[data-slot="reference-overflow"]')).toBeNull()
    } finally {
      rect.mockRestore()
      vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    }
  })
  it('gives inline references priority over the droppable age', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const slot = this.getAttribute('data-slot')
      const left = slot === 'reference-list' ? 70 : 0
      const width = slot === 'fit-line' ? 130 : slot === 'task-row-age' ? 30 : slot === 'separator' ? 10 : 50
      return { left, right: left + width, width, top: 0, bottom: 16, height: 16, x: left, y: 0, toJSON() {} }
    })
    try {
      const { container } = render(<MemoryRouter><span data-slot="fit-line">
        <ReferenceList references={references.slice(0, 1)} maxVisible={2} taskTitle="Split work" runId="run" plain compact fitContainer />
        <span data-slot="separator" aria-hidden="true"> · </span><span data-slot="task-row-age">30m</span>
      </span></MemoryRouter>)
      await waitFor(() => expect(container.querySelectorAll('[data-slot="pr-chip"]')).toHaveLength(1))
      expect(container.querySelector('[data-slot="reference-overflow"]')).toBeNull()
    } finally { rect.mockRestore() }
  })
  it('shows two compact references and names every hidden reference', () => {
    const { container } = list()
    expect(container.querySelectorAll('[data-slot="pr-chip"]')).toHaveLength(2)
    expect(container.querySelector('[data-slot="pr-chip"]')?.textContent).toBe('#812')
    const trigger = screen.getByRole('button', { name: 'Show all 5 references for Split work' })
    expect(trigger.textContent).toBe('+3')
    expect(trigger.getAttribute('title')).toBe('PR #814, PR #815, PR #816')
  })
  it('opens all links with mouse keyboard and touch', async () => {
    list(1)
    const trigger = screen.getByRole('button', { name: 'Show all 5 references for Split work' })
    expect(trigger.textContent).toBe('+4')
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' })
    fireEvent.click(trigger)
    await waitFor(() => expect(document.querySelector('[data-slot="reference-overflow-list"]')).not.toBeNull())
    const panel = document.querySelector('[data-slot="reference-overflow-list"]')!
    expect([...panel.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(references.map(ref => `/p/other-project/tasks/run/pr/${ref.number}`))
    fireEvent.keyDown(trigger, { key: 'Escape' })
  })
  it('keeps scope and focus when overflow is portaled', async () => {
    list()
    const trigger = screen.getByRole('button', { name: 'Show all 5 references for Split work' })
    trigger.focus()
    fireEvent.click(trigger)
    await waitFor(() => expect(document.querySelector('[data-slot="reference-overflow-list"]')).not.toBeNull())
    fireEvent.pointerEnter(document.querySelector('[data-slot="reference-overflow-list"]')!, { pointerType: 'mouse' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
