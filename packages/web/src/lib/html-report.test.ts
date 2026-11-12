import { describe, expect, it } from 'vitest'
import { TAILWIND_V3_CONFIG_SHIM } from './report-libraries'
import { isHtmlPath, prepareReport, REPORT_ALLOW, REPORT_CSP, REPORT_SANDBOX, WRAPPER_CSP, wrapReport } from './html-report'

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
    expect(REPORT_CSP).toContain("script-src 'unsafe-inline' data:;")
    expect(REPORT_CSP).not.toMatch(/https?:|\*|connect-src|'self'|unsafe-eval/)
  })

  it('runs scripts in an opaque origin, with no same-origin, top navigation or forms', () => {
    expect(REPORT_SANDBOX.split(' ').sort()).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-scripts'])
    expect(REPORT_ALLOW).toBe('clipboard-write')
  })

  it('wraps a fragment without a head or a doctype', () => {
    const doc = parse(prepareReport('<h1>Plain</h1>').srcdoc)
    expect(doc.head.firstElementChild!.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(doc.body.textContent).toBe('Plain')
  })

  it('removes remote scripts, base, meta refresh, embeds and resource hints, and counts them', () => {
    const { srcdoc, blocked } = prepareReport(`<head>
      <meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/">
      <link rel="preconnect" href="https://evil.test"><link rel="dns-prefetch" href="//evil.test"><link rel="modulepreload" href="https://cdn.test/m.js">
      <script src="https://cdn.test/x.js"></script><script type="module" src="//cdn.test/m.js"></script><script src="local.js"></script>
    </head><body><iframe src="/api/v1/health"></iframe><object data="x.swf"></object><embed src="x"><a ping="https://evil.test" href="#a">A</a></body>`)
    const doc = parse(srcdoc)
    for (const selector of ['script', 'base', 'meta[http-equiv="refresh"]', 'link[rel="preconnect"]', 'link[rel="dns-prefetch"]', 'link[rel="modulepreload"]', 'iframe', 'object', 'embed', '[ping]']) {
      expect(doc.querySelector(selector), selector).toBeNull()
    }
    expect(blocked.scripts).toBe(3)
    expect(blocked.embeds).toBe(3)
  })

  it('reads a script source from src, or href and xlink:href on SVG, and keeps data URL sources', () => {
    const XLINK = 'http://www.w3.org/1999/xlink'
    const { srcdoc, blocked } = prepareReport(`<script src="data:text/javascript,window.a=1"></script>
      <svg xmlns:xlink="${XLINK}"><script href="https://x.test/a.js"></script><script xlink:href="//x.test/b.js"></script>
      <script href="data:text/javascript,window.b=1"></script></svg>`)
    const scripts = [...parse(srcdoc).querySelectorAll('script')]
    expect(scripts.map(script => script.getAttribute('src') ?? script.getAttribute('href'))).toEqual(['data:text/javascript,window.a=1', 'data:text/javascript,window.b=1'])
    expect(blocked.scripts).toBe(2)
  })

  it('reads src only on an HTML script and href only on an SVG script', () => {
    const { srcdoc, blocked } = prepareReport(`<script href="https://x.test/a.js">window.inline = 1</script>
      <svg><script id="svg" src="data:text/javascript,1" href="https://x.test/b.js"></script></svg>`)
    const doc = parse(srcdoc)
    expect([...doc.querySelectorAll('script')].map(script => script.textContent)).toEqual(['window.inline = 1'])
    expect(doc.getElementById('svg')).toBeNull()
    expect(blocked.scripts).toBe(1)
  })

  it('keeps inline scripts, module scripts and event attributes', () => {
    const { srcdoc, blocked } = prepareReport(`<head><script>window.tabs = 1</script></head><body onload="init()">
      <button onclick="navigator.clipboard.writeText('x')">Copy</button><script type="module">document.body.dataset.ready = '1'</script></body>`)
    const doc = parse(srcdoc)
    expect([...doc.querySelectorAll('script')].map(script => [script.getAttribute('type'), script.textContent])).toEqual([
      [null, 'window.tabs = 1'], ['module', "document.body.dataset.ready = '1'"],
    ])
    expect(doc.body.getAttribute('onload')).toBe('init()')
    expect(doc.querySelector('button')!.getAttribute('onclick')).toBe("navigator.clipboard.writeText('x')")
    expect(blocked.scripts).toBe(0)
  })

  it('keeps in-page anchors and opens web and mail links in a new tab without opener or referrer', () => {
    const doc = parse(prepareReport('<a href="#s2" target="_top">TOC</a><a href="https://example.com" target="_self">Web</a><a href="mailto:a@example.com">Mail</a><h2 id="s2">S2</h2>').srcdoc)
    const [toc, web, mail] = [...doc.querySelectorAll('a')]
    expect(toc!.getAttribute('href')).toBe('about:srcdoc#s2')
    expect(toc!.hasAttribute('target')).toBe(false)
    for (const link of [web!, mail!]) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('applies the same link policy to SVG xlink:href links', () => {
    const XLINK = 'http://www.w3.org/1999/xlink'
    const { srcdoc, blocked } = prepareReport(`<svg xmlns:xlink="${XLINK}">
      <a id="web" xlink:href="https://example.com/" target="_self"><text>Web</text></a>
      <a id="rel" xlink:href="other.html"><text>Rel</text></a>
      <a id="toc" xlink:href="#s2" target="_top"><text>Toc</text></a></svg>`)
    const doc = parse(srcdoc)
    const link = (id: string) => doc.getElementById(id)!
    expect(link('web').getAttributeNS(XLINK, 'href')).toBe('https://example.com/')
    expect(link('web').getAttribute('target')).toBe('_blank')
    expect(link('web').getAttribute('rel')).toBe('noopener noreferrer')
    expect(link('rel').hasAttributeNS(XLINK, 'href')).toBe(false)
    expect(link('rel').hasAttribute('href')).toBe(false)
    expect(link('toc').getAttribute('href')).toBe('about:srcdoc#s2')
    expect(link('toc').hasAttributeNS(XLINK, 'href')).toBe(false)
    expect(link('toc').hasAttribute('target')).toBe(false)
    expect(blocked.relative).toBe(1)
  })

  it.each(['#', '#section%202', '#résultats'])('keeps fragment %s inside the srcdoc document for links and image maps', href => {
    const { srcdoc, blocked } = prepareReport(`<a href="${href}" target="_blank">Section</a><map name="toc"><area href="${href}" target="_top"></map>`)
    const doc = parse(srcdoc)
    expect([...doc.querySelectorAll('a, area')].map(link => [link.localName, link.getAttribute('href'), link.getAttribute('target')])).toEqual([
      ['a', `about:srcdoc${href}`, null], ['area', `about:srcdoc${href}`, null],
    ])
    expect(blocked).toEqual({ scripts: 0, remote: 0, relative: 0, forms: 0, embeds: 0 })
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

  it('reads a data URL inside srcset as one embedded candidate, commas included', () => {
    const { blocked } = prepareReport('<img srcset="data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x"><img srcset="a.png 1x, https://x.test/b.png 2x">')
    expect(blocked).toMatchObject({ relative: 1, remote: 1 })
  })

  it('strips form actions and counts forms', () => {
    const { srcdoc, blocked } = prepareReport('<form action="https://evil.test" method="post"><button formaction="/api/v1/runs">Go</button></form>')
    const doc = parse(srcdoc)
    expect(doc.querySelector('form')!.hasAttribute('action')).toBe(false)
    expect(doc.querySelector('button')!.hasAttribute('formaction')).toBe(false)
    expect(blocked.forms).toBe(1)
  })

  it('counts nothing for a style sheet that is not CSS, such as a Tailwind source sheet', () => {
    const { blocked } = prepareReport('<style type="text/tailwindcss">@import "tailwindcss"; @theme { --c: url(x.png) }</style><style type="TEXT/CSS">a{background:url(y.png)}</style>')
    expect(blocked.relative).toBe(1)
  })

  it('reports nothing blocked for a self-contained report', () => {
    const { blocked } = prepareReport('<style>p{color:red}</style><p>Ok</p><a href="#top">Top</a>')
    expect(blocked).toEqual({ scripts: 0, remote: 0, relative: 0, forms: 0, embeds: 0 })
  })
})

const TW = '/* tailwind */'
const MERMAID = '/* mermaid </script> */'
const COMPAT = '@theme{}'

describe('prepareReport with report libraries', () => {
  it.each([
    'https://cdn.tailwindcss.com', 'https://cdn.tailwindcss.com/3.4.17', 'https://cdn.tailwindcss.com?plugins=forms',
    'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4', 'https://unpkg.com/@tailwindcss/browser@4.1.0/dist/index.global.js',
  ])('puts the pinned Tailwind code in place of %s', src => {
    const { srcdoc, blocked } = prepareReport(`<head><style>p{}</style><script src="${src}"></script><style>h1{}</style></head><body><p>x</p></body>`, { tailwind: TW, 'tailwind-v3': COMPAT })
    const head = [...parse(srcdoc).head.children].slice(2).map(node => `${node.tagName}:${node.getAttribute('type') ?? ''}:${node.textContent}`)
    const compat = src.includes('cdn.tailwindcss.com') ? ['STYLE:text/tailwindcss:@theme{}', `SCRIPT::${TAILWIND_V3_CONFIG_SHIM}`] : []
    expect(head).toEqual(['STYLE::p{}', ...compat, `SCRIPT::${TW}`, 'STYLE::h1{}'])
    expect(blocked.scripts).toBe(0)
  })

  it('runs a deferred library tag at the end of body, once, and escapes the end tag in its code', () => {
    const { srcdoc } = prepareReport(`<head><script defer src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
      <script src="https://unpkg.com/mermaid@11.4.0/dist/mermaid.min.js"></script></head><body><pre class="mermaid">graph TD; A-->B</pre></body>`, { mermaid: MERMAID })
    expect(srcdoc).toContain('<pre class="mermaid">graph TD; A--&gt;B</pre><script>/* mermaid <\\/script> */</script></body>')
    expect(parse(srcdoc).querySelectorAll('script')).toHaveLength(1)
  })

  it('keeps the v3 compat sheet and config API at a deferred v3 tag, and runs the code at the end of body', () => {
    const { srcdoc } = prepareReport('<head><script defer src="https://cdn.tailwindcss.com"></script><script>tailwind.config = {}</script></head><body><p>x</p></body>', { tailwind: TW, 'tailwind-v3': COMPAT })
    const doc = parse(srcdoc)
    expect([...doc.head.children].slice(2).map(node => node.textContent)).toEqual([COMPAT, TAILWIND_V3_CONFIG_SHIM, 'tailwind.config = {}'])
    expect(doc.body.lastElementChild!.textContent).toBe(TW)
  })

  it('maps Mermaid module imports to the inline Mermaid code through an import map', () => {
    const esm = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
    const { srcdoc, blocked } = prepareReport(`<script type="module">import mermaid from '${esm}'; mermaid.run()</script>
      <script type="module">const m = await import("https://unpkg.com/mermaid@11.2.0/dist/mermaid.esm.mjs")</script>`, { mermaid: MERMAID })
    const doc = parse(srcdoc)
    const [map, code] = [...doc.head.querySelectorAll('script')]
    expect(map!.getAttribute('type')).toBe('importmap')
    const shim = `data:text/javascript,${encodeURIComponent('export default globalThis.mermaid')}`
    expect(JSON.parse(map!.textContent!)).toEqual({ imports: { [esm]: shim, 'https://unpkg.com/mermaid@11.2.0/dist/mermaid.esm.mjs': shim } })
    expect(code!.textContent).toBe('/* mermaid <\\/script> */')
    expect(blocked.scripts).toBe(0)
  })

  it('blocks and counts a library whose code did not load, an unknown CDN and another major version', () => {
    const { srcdoc, blocked } = prepareReport(`<script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
      <script type="module">import m from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'</script>`, { tailwind: TW })
    const doc = parse(srcdoc)
    expect([...doc.querySelectorAll('script')].map(script => script.getAttribute('type'))).toEqual(['module'])
    expect(blocked.scripts).toBe(4)
  })
})

describe('wrapReport', () => {
  it('holds only the report frame, under the same sandbox, with every navigation of it refused', () => {
    const inner = prepareReport('<p title="a&quot;b">R&amp;D</p><script>x = "&"</script>').srcdoc
    const wrapper = parse(wrapReport(inner, 'Report: "q" & a'))
    expect(WRAPPER_CSP).toBe(`${REPORT_CSP}; frame-src 'none'`)
    expect(wrapper.head.firstElementChild!.getAttribute('content')).toBe(WRAPPER_CSP)
    expect(wrapper.querySelectorAll('script')).toHaveLength(0)
    const frames = wrapper.querySelectorAll('iframe')
    expect(frames).toHaveLength(1)
    expect(frames[0]!.getAttribute('sandbox')).toBe(REPORT_SANDBOX)
    expect(frames[0]!.getAttribute('allow')).toBe(REPORT_ALLOW)
    expect(frames[0]!.getAttribute('title')).toBe('Report: "q" & a')
    expect(frames[0]!.getAttribute('srcdoc')).toBe(inner)
  })
})
