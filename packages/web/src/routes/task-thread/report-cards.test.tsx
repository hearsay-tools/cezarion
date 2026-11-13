import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TaskFileContext } from './file-links'
import { AssistantMessage, UserBubble } from './thread-items'
import { ReportCards, ReportOpenContext, reportReferences } from './report-cards'

const { metadata } = vi.hoisted(() => ({ metadata: vi.fn() }))
vi.mock('@/api/queries', () => ({ useArtifactMetadata: metadata }))
const artifactId = '11111111-1111-4111-8111-111111111111'
const context = { runId: 'run-1', projectId: 'project-1' }
const href = `/p/project-1/tasks/run-1/files?artifact=${artifactId}`
const text = `The answer remains. [findings.html](${href})`
function Location() {
  const location = useLocation()
  return <output data-navigation-state={JSON.stringify(location.state)}>{location.pathname}{location.search}</output>
}
function setup() {
  return render(<MemoryRouter initialEntries={['/p/project-1/tasks/run-1']}><TaskFileContext.Provider value={context}>
    <p>The answer remains.</p><ReportCards text={text} messageKey="message-1" /><Location />
  </TaskFileContext.Provider></MemoryRouter>)
}
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('report reference discovery', () => {
  it('de-duplicates a publication in source order and preserves distinct reports', () => {
    const other = '22222222-2222-4222-8222-222222222222'
    expect(reportReferences(`${text} [again](${href}) [second](${href.replace(artifactId, other)})`, context).map(item => item.artifactId)).toEqual([artifactId, other])
  })
  it('ignores remote URLs, local HTML paths, code, images and other projects', () => {
    expect(reportReferences(`\`[code](${href})\` ![image](${href}) [remote](https://example.com/report.html) [local](/tmp/report.html) [foreign](${href.replace('project-1', 'project-2')})`, context)).toEqual([])
  })
  it('reads the escaped file labels emitted by artifact publish', () => {
    const escaped = `[report\\-results\\[2\\]\\.html](${href})`
    expect(reportReferences(escaped, context)[0]?.label).toBe('report-results[2].html')
    expect(reportReferences(`!${escaped}`, context)).toEqual([])
  })
  it('keeps same-project worker publications with their source task', () => {
    expect(reportReferences(text.replace('tasks/run-1', 'tasks/worker-1'), context)[0]?.runId).toBe('worker-1')
  })
  it('does not offer an unfinished streaming link', () => {
    expect(reportReferences(`[findings](${href}`, context)).toEqual([])
  })
})

describe('report cards', () => {
  it('places one card after assistant text and leaves user messages as plain links', () => {
    metadata.mockReturnValue({ isPending: false, data: { artifact: { name: 'findings.html', title: 'Findings' } } })
    const { container } = render(<MemoryRouter initialEntries={['/p/project-1/tasks/run-1']}><TaskFileContext.Provider value={context}>
      <AssistantMessage text={`${text} [again](${href})`} messageKey="message-1" />
      <UserBubble text={text} />
    </TaskFileContext.Provider></MemoryRouter>)
    expect(container.querySelectorAll('[data-slot="report-card"]')).toHaveLength(1)
    const card = container.querySelector('[data-slot="report-cards"]')!
    expect(card.previousElementSibling?.textContent).toContain('The answer remains.')
    expect(card.closest('[data-slot="assistant-message"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="user-bubble"] [data-slot="report-card"]')).toBeNull()
  })

  it('closes the containing sheet before navigating to the reader', () => {
    metadata.mockReturnValue({ isPending: false, data: { artifact: { name: 'findings.html', title: 'Findings' } } })
    const close = vi.fn(() => expect(screen.getByRole('status').textContent).not.toContain('?report='))
    render(<MemoryRouter initialEntries={['/p/project-1/tasks/run-1']}><TaskFileContext.Provider value={context}>
      <ReportOpenContext.Provider value={close}><ReportCards text={text} messageKey="message-1" /></ReportOpenContext.Provider><Location />
    </TaskFileContext.Provider></MemoryRouter>)
    fireEvent.click(screen.getByRole('link', { name: 'Read report' }))
    expect(close).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain(`?report=${artifactId}`)
  })

  it('copies the message as plain HTML links without card controls', async () => {
    metadata.mockReturnValue({ isPending: false, data: { artifact: { name: 'findings.html', title: 'Findings' } } })
    const write = vi.fn(async (_items: unknown[]) => {})
    vi.stubGlobal('ClipboardItem', class ClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    })
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write } })
    render(<MemoryRouter initialEntries={['/p/project-1/tasks/run-1']}><TaskFileContext.Provider value={context}>
      <AssistantMessage text={text} messageKey="message-1" />
    </TaskFileContext.Provider></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    const item = write.mock.calls[0]![0][0] as { items: Record<string, Blob> }
    const html = await item.items['text/html']!.text()
    expect(html).toContain('<a')
    expect(html).toContain('findings.html')
    expect(html).not.toContain('Read report')
    expect(html).not.toContain('report-card')
  })
  it('loads metadata only and keeps Read working while loading', () => {
    metadata.mockReturnValue({ isPending: true })
    const { container } = setup()
    expect(screen.getByRole('heading', { name: 'findings.html' })).toBeTruthy()
    expect(screen.getByText('The answer remains.')).toBeTruthy()
    expect(metadata).toHaveBeenCalledWith('run-1', artifactId)
    expect(container.querySelector('iframe')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'Read report' }))
    expect(screen.getByRole('status').textContent).toBe(`/p/project-1/tasks/run-1?report=${artifactId}&card=message-1`)
    expect(JSON.parse(screen.getByRole('status').getAttribute('data-navigation-state')!)).toMatchObject({ reportReturnTo: '/p/project-1/tasks/run-1' })
  })
  it('captures conversation scroll when Read is activated', () => {
    metadata.mockReturnValue({ isPending: true })
    const scroller = document.createElement('div')
    scroller.dataset.slot = 'main'
    scroller.scrollTop = 20
    document.body.append(scroller)
    try {
      setup()
      scroller.scrollTop = 106
      fireEvent.click(screen.getByRole('link', { name: 'Read report' }))
      expect(JSON.parse(screen.getByRole('status').getAttribute('data-navigation-state')!)).toMatchObject({ reportScrollTop: 106 })
    } finally { scroller.remove() }
  })
  it('keeps the original return entry when another report is already open', () => {
    metadata.mockReturnValue({ isPending: true })
    render(<MemoryRouter initialEntries={[{ pathname: '/p/project-1/tasks/run-1', search: '?report=22222222-2222-4222-8222-222222222222&card=older', state: { reportReturnTo: '/p/project-1/tasks/run-1?thread=flat', reportReturnKey: 'original-entry', reportScrollTop: 222 } }]}><TaskFileContext.Provider value={context}>
      <ReportCards text={text} messageKey="message-1" /><Location />
    </TaskFileContext.Provider></MemoryRouter>)
    fireEvent.click(screen.getByRole('link', { name: 'Read report' }))
    expect(JSON.parse(screen.getByRole('status').getAttribute('data-navigation-state')!)).toMatchObject({ reportReturnTo: '/p/project-1/tasks/run-1?thread=flat', reportReturnKey: 'original-entry', reportScrollTop: 222 })
  })
  it('uses the metadata title and HTML label after loading', () => {
    metadata.mockReturnValue({ isPending: false, data: { artifact: { id: artifactId, name: 'findings.html', title: 'Release findings' } } })
    setup()
    expect(screen.getByRole('heading', { name: 'Release findings' })).toBeTruthy()
    expect(screen.getByText('HTML report')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Read report' })).toBeTruthy()
  })
  it.each([404, 500])('keeps the answer and original reader link after metadata error %s', status => {
    metadata.mockReturnValue({ isError: true, error: { status } })
    setup()
    expect(screen.getByText('The answer remains.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'findings.html' }).getAttribute('href')).toBe(href.replace('/files?', '/report?'))
    expect(screen.queryByText('HTML report')).toBeNull()
  })
  it('does not show a card for a non-HTML publication', () => {
    metadata.mockReturnValue({ isPending: false, data: { artifact: { name: 'notes.md' } } })
    setup()
    expect(screen.queryByText('HTML report')).toBeNull()
  })
})
