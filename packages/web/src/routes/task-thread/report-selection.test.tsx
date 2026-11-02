import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType, useParams } from 'react-router'
import { parseReportSelection, useConversationReport } from './report-selection'

const id = 'b962b341-4d95-4d46-a107-f278ab187228'
describe('conversation report URL selection', () => {
  it.each(['', 'card=message', 'report=', 'report=invalid', `report=${id}&report=${id}`, `report=${id}&card=a&card=b`])('selects nothing for %s', query => {
    expect(parseReportSelection(new URLSearchParams(query))).toBeNull()
  })
  it('restores the report and its opener without storing display metadata', () => {
    expect(parseReportSelection(new URLSearchParams({ report: id, card: 'message:42', title: 'stale title' }))).toEqual({ artifactId: id, card: 'message:42' })
  })
  it('allows a report bookmark without a card', () => {
    expect(parseReportSelection(new URLSearchParams({ report: id }))).toEqual({ artifactId: id, card: null })
  })
})

// History, source ownership and task switches use the real router; display fields never enter it.

const restoreOpener = vi.fn((artifactId: string, _scrollTop?: number) => {
  document.getElementById(`report-card-message-${artifactId}`)?.focus({ preventScroll: true })
})
afterEach(() => { cleanup(); restoreOpener.mockClear() })

function Conversation() {
  const { id: runId } = useParams()
  const report = useConversationReport(runId)
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  useLayoutEffect(() => {
    const source = report.registry.register(id, 'worker')
    const opener = report.registry.registerOpener('message', restoreOpener)
    return () => { source(); opener() }
  }, [report.registry])
  return <>
    <output data-testid="navigation">{navigationType}</output>
    <output data-testid="url">{location.pathname + location.search}</output>
    <output data-testid="source">{report.sourceRunId ?? 'none'}</output>
    <button id={`report-card-message-${id}`} onClick={() => navigate(`?report=${id}&card=message`, { state: { reportCardEntry: true, reportScrollTop: 740 } })}>Read report</button>
    <button onClick={report.close}>Close</button>
    <button onClick={() => navigate('/tasks/two')}>Other task</button>
    <button onClick={() => navigate(-1)}>History Back</button>
  </>
}

function at(path: string) {
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/tasks/:id" element={<Conversation />} /></Routes></MemoryRouter>)
}

it('loads nothing without a selection and resolves the worker source from the publication', () => {
  at('/tasks/one')
  expect(screen.getByTestId('source').textContent).toBe('none')
  fireEvent.click(screen.getByText('Read report'))
  expect(screen.getByTestId('source').textContent).toBe('worker')
  fireEvent.click(screen.getByText('Close'))
  expect(screen.getByTestId('url').textContent).toBe('/tasks/one')
  expect(document.activeElement?.id).toBe(`report-card-message-${id}`)
  expect(restoreOpener).toHaveBeenCalledWith(id, 740)
})

it('restores URL selection after a task switch without leaking it to the other task', () => {
  at('/tasks/one')
  fireEvent.click(screen.getByText('Read report'))
  fireEvent.click(screen.getByText('Other task'))
  expect(screen.getByTestId('source').textContent).toBe('none')
  expect(screen.getByTestId('url').textContent).toBe('/tasks/two')
  fireEvent.click(screen.getByText('History Back'))
  expect(screen.getByTestId('source').textContent).toBe('worker')
  fireEvent.click(screen.getByText('Close'))
  expect(screen.getByTestId('url').textContent).toBe('/tasks/one')
  expect(document.activeElement?.id).toBe(`report-card-message-${id}`)
  expect(restoreOpener).toHaveBeenCalledWith(id, 740)
})

it('replaces an invalid selection and closes a cold bookmark without leaving the task', () => {
  at('/tasks/one?report=invalid&card=message&thread=flat')
  expect(screen.getByTestId('url').textContent).toBe('/tasks/one?thread=flat')
  expect(screen.getByTestId('navigation').textContent).toBe('REPLACE')
})

it('closes a cold selection by replacement', () => {
  at(`/tasks/one?report=${id}&card=message&thread=flat`)
  fireEvent.click(screen.getByText('Close'))
  expect(screen.getByTestId('url').textContent).toBe('/tasks/one?thread=flat')
  expect(screen.getByTestId('navigation').textContent).toBe('REPLACE')
})
