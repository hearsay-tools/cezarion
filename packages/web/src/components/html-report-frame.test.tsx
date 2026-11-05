import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HtmlReportFrame } from './html-report-frame'

const loaded = vi.hoisted(() => ({ fail: false, release: () => {} }))
vi.mock('@/lib/report-libraries', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/report-libraries')>()
  return {
    ...actual,
    loadLibraries: (ids: string[]) => new Promise(done => {
      loaded.release = () => done(loaded.fail ? {} : Object.fromEntries(ids.map(id => [id, `/* ${id} code */`])))
    }),
  }
})

afterEach(() => { cleanup(); loaded.fail = false })

const frame = () => document.querySelector<HTMLIFrameElement>('[data-slot="html-report-frame"]')
const reportOf = (wrapper: string) => new DOMParser().parseFromString(new DOMParser().parseFromString(wrapper, 'text/html').querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html')

describe('HtmlReportFrame', () => {
  it('renders a report that names no library at once', () => {
    render(<HtmlReportFrame html="<script>tabs()</script>" title="R" />)
    expect(reportOf(frame()!.getAttribute('srcdoc')!).querySelector('script')!.textContent).toBe('tabs()')
  })

  it('waits for the library code, then puts it in place of the CDN tag', async () => {
    const { container } = render(<HtmlReportFrame html={'<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script><p class="p-4">x</p>'} title="R" />)
    expect(frame()).toBeNull()
    expect(container.querySelector('[data-slot="html-report"]')!.getAttribute('aria-busy')).toBe('true')
    await act(async () => loaded.release())
    await waitFor(() => expect(frame()).not.toBeNull())
    expect(reportOf(frame()!.getAttribute('srcdoc')!).querySelector('script')!.textContent).toBe('/* tailwind code */')
    expect(document.querySelector('[data-slot="html-report-blocked"]')).toBeNull()
  })

  it('blocks and counts a library whose code failed to load', async () => {
    loaded.fail = true
    render(<HtmlReportFrame html={'<script src="https://cdn.tailwindcss.com"></script><p>x</p>'} title="R" />)
    await act(async () => loaded.release())
    await waitFor(() => expect(document.querySelector('[data-slot="html-report-blocked"]')?.textContent).toContain('1 remote script'))
    expect(reportOf(frame()!.getAttribute('srcdoc')!).querySelector('script')).toBeNull()
  })
})
