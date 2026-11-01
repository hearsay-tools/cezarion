import { describe, expect, it } from 'vitest'
import { isHtmlPath, prepareReport, REPORT_CSP } from './html-report'

const parse = (srcdoc: string) => new DOMParser().parseFromString(srcdoc, 'text/html')

describe('isHtmlPath', () => {
  it.each(['report.html', 'a/b/REPORT.HTM', '/tmp/x.html'])('recognizes %s', path => expect(isHtmlPath(path)).toBe(true))
  it.each(['report.md', 'report.html.txt', 'html', 'x.xhtml'])('ignores %s', path => expect(isHtmlPath(path)).toBe(false))
})

describe('prepareReport', () => {
  it('puts the CSP and the referrer policy first in head, in standards mode', () => {
    const { srcdoc } = prepareReport('<!doctype html><html><head><title>T</title><link rel="stylesheet" href="https://cdn.test/a.css"></head><body><p>Hi</p></body></html>')
    expect(srcdoc.startsWith('<!DOCTYPE html>')).toBe(true)
    const doc = parse(srcdoc)
    expect(doc.compatMode).toBe('CSS1Compat')
    const first = doc.head.firstElementChild!
    expect(first.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first.getAttribute('content')).toBe(REPORT_CSP)
    expect(doc.head.children[1]!.getAttribute('name')).toBe('referrer')
    expect(REPORT_CSP).toContain("default-src 'none'")
    expect(REPORT_CSP).not.toMatch(/script-src|https?:/)
  })

  it('wraps a fragment without a head or a doctype', () => {
    const doc = parse(prepareReport('<h1>Plain</h1>').srcdoc)
    expect(doc.head.firstElementChild!.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(doc.body.textContent).toBe('Plain')
  })

  it('removes scripts, base, meta refresh, embeds and resource hints, and counts them', () => {
    const { srcdoc, blocked } = prepareReport(`<head>
      <meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/">
      <link rel="preconnect" href="https://evil.test"><link rel="dns-prefetch" href="//evil.test">
      <script>parent.document.title = 'owned'</script><script src="https://cdn.test/x.js"></script>
    </head><body onload="steal()"><iframe src="/api/v1/health"></iframe><object data="x.swf"></object><embed src="x"></body>`)
    const doc = parse(srcdoc)
    for (const selector of ['script', 'base', 'meta[http-equiv="refresh"]', 'link[rel="preconnect"]', 'link[rel="dns-prefetch"]', 'iframe', 'object', 'embed']) {
      expect(doc.querySelector(selector), selector).toBeNull()
    }
    expect(doc.body.hasAttribute('onload')).toBe(false)
    expect(blocked.scripts).toBe(2)
    expect(blocked.embeds).toBe(3)
  })

  it('keeps in-page anchors and opens web and mail links in a new tab without opener or referrer', () => {
    const doc = parse(prepareReport('<a href="#s2" target="_top">TOC</a><a href="https://example.com" target="_self">Web</a><a href="mailto:a@example.com">Mail</a><h2 id="s2">S2</h2>').srcdoc)
    const [toc, web, mail] = [...doc.querySelectorAll('a')]
    expect(toc!.getAttribute('href')).toBe('#s2')
    expect(toc!.hasAttribute('target')).toBe(false)
    for (const link of [web!, mail!]) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('makes relative and script links inert and counts the relative ones', () => {
    const { srcdoc, blocked } = prepareReport('<a href="other.html">Next</a><a href="/api/v1/health">Api</a><a href="javascript:steal()">JS</a><area href="sub/x.html">')
    const doc = parse(srcdoc)
    expect([...doc.querySelectorAll('a, area')].filter(link => link.hasAttribute('href'))).toEqual([])
    expect(blocked.relative).toBe(3)
  })

  it('counts remote and relative resources and keeps embedded data', () => {
    const { srcdoc, blocked } = prepareReport(`<style>@import url("https://cdn.test/a.css"); body { background: url(bg.png) } i { background: url(data:image/png;base64,AA==) }</style>
      <link rel="stylesheet" href="https://cdn.test/b.css"><img src="https://example.com/a.png"><img src="chart.png"><img src="data:image/png;base64,AA==">
      <img srcset="x.png 2x"><video poster="p.png"></video><div style="background-image:url('https://example.com/c.png')"></div>`)
    expect(blocked.remote).toBe(4)
    expect(blocked.relative).toBe(4)
    expect(parse(srcdoc).querySelectorAll('img')).toHaveLength(4)
  })

  it('strips form actions and counts forms', () => {
    const { srcdoc, blocked } = prepareReport('<form action="https://evil.test" method="post"><button formaction="/api/v1/runs">Go</button></form>')
    const doc = parse(srcdoc)
    expect(doc.querySelector('form')!.hasAttribute('action')).toBe(false)
    expect(doc.querySelector('button')!.hasAttribute('formaction')).toBe(false)
    expect(blocked.forms).toBe(1)
  })

  it('reports nothing blocked for a self-contained report', () => {
    const { blocked } = prepareReport('<style>p{color:red}</style><p>Ok</p><a href="#top">Top</a>')
    expect(blocked).toEqual({ scripts: 0, remote: 0, relative: 0, forms: 0, embeds: 0 })
  })
})
