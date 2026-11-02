import { cleanup, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReportCardSourcesContext } from './report-selection'
import { reportButtonId } from './report-cards'
import { SessionTranscript, type TranscriptRowModel } from './session-transcript'
import type { ThreadScrollControls } from './thread-scroller'
import { transcriptReportMessages, useTranscriptReports } from './transcript-reports'

vi.mock('./thread-scroller', () => ({
  useThreadScroll: () => ({ jumpToRow }),
  ThreadRows: () => null,
  JumpToLatestPill: () => null,
}))

const artifactId = '11111111-1111-4111-8111-111111111111'
const href = `/p/project/tasks/worker/files?artifact=${artifactId}`
const rows: TranscriptRowModel[] = [{ key: 'turn:old-message', scope: 'turn', content: {
  kind: 'block', block: { kind: 'entry', id: 'old-message', entry: { kind: 'message', id: 'old-message', role: 'assistant', text: `[report.html](${href})` } },
} }]
const jumpToRow = vi.fn<ThreadScrollControls['jumpToRow']>()
const register = vi.fn(() => vi.fn())
const registerOpener = vi.fn((_key: string, _restore: (id: string) => void) => vi.fn())

afterEach(() => { cleanup(); vi.clearAllMocks() })

function Transcript({ mode }: { mode: 'document' | 'panel' }) {
  useTranscriptReports('conversation', rows, { jumpToRow }, mode)
  // Deliberately mount no row or card: a virtualizer can omit this old message.
  return null
}
function mount(mode: 'document' | 'panel' = 'document') {
  return render(<MemoryRouter initialEntries={['/p/project/tasks/conversation']}>
    <ReportCardSourcesContext.Provider value={{ register, registerOpener }}>
      <Routes><Route path="/p/:projectId/tasks/:id" element={<Transcript mode={mode} />} /></Routes>
    </ReportCardSourcesContext.Provider>
  </MemoryRouter>)
}

describe('report registration before transcript virtualization', () => {
  it('integrates registration above the virtual renderer even when it mounts no message', () => {
    render(<MemoryRouter initialEntries={['/p/project/tasks/conversation']}>
      <ReportCardSourcesContext.Provider value={{ register, registerOpener }}>
        <Routes><Route path="/p/:projectId/tasks/:id" element={<SessionTranscript runId="conversation" viewId="main" mode="document" renderMode="virtual"
          sections={[{ id: 'turn', entries: [{ kind: 'message', id: 'old-message', role: 'assistant', text: `[report.html](${href})` }] }]} />} /></Routes>
      </ReportCardSourcesContext.Provider>
    </MemoryRouter>)
    expect(register).toHaveBeenCalledExactlyOnceWith(artifactId, 'worker')
    expect(registerOpener).toHaveBeenCalledWith('turn:old-message', expect.any(Function))
    expect(document.querySelector('[data-slot="assistant-message"]')).toBeNull()
  })

  it('registers offscreen source ownership from row data with the matched project', () => {
    mount()
    expect(document.querySelector('[data-slot="report-card"]')).toBeNull()
    expect(register).toHaveBeenCalledExactlyOnceWith(artifactId, 'worker')
    expect(registerOpener).toHaveBeenCalledWith('turn:old-message', expect.any(Function))
  })

  it('restores an offscreen opener through the scroller and selects its exact button', () => {
    mount()
    registerOpener.mock.calls[0]![1](artifactId)
    expect(jumpToRow).toHaveBeenCalledWith('turn:old-message', 0, expect.any(Function))
    const focusTarget = jumpToRow.mock.calls[0]![2]!
    const row = document.createElement('div')
    const other = document.createElement('button')
    const button = document.createElement('a')
    button.id = reportButtonId('turn:old-message', artifactId)
    row.append(other, button)
    expect(focusTarget(row)).toBe(button)
  })

  it('does not let an attributed worker panel replace document opener callbacks', () => {
    mount('panel')
    expect(register).toHaveBeenCalledWith(artifactId, 'worker')
    expect(registerOpener).not.toHaveBeenCalled()
  })

  it('unregisters opener callbacks when the transcript leaves', () => {
    const view = mount()
    const remove = registerOpener.mock.results[0]!.value
    view.unmount()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('ignores user messages while retaining the stable assistant message and row keys', () => {
    const user: TranscriptRowModel = { key: 'user', scope: 'turn', content: { kind: 'user-message', message: { text: `[report.html](${href})` } } }
    expect(transcriptReportMessages([user, ...rows])).toEqual([{ messageKey: 'turn:old-message', text: `[report.html](${href})`, rowKey: 'turn:old-message', rowIndex: 1 }])
  })
})
