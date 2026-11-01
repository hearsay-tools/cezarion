import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareSetters, readSetterBaseline, scanSetters, scanTree } from './raw-query-setter.ts'

/** The baseline `cez/raw-query-setter` reads; `npm run lint` applies the rule to the cockpit. */
const baseline = { sites: readSetterBaseline() }

const imported = `import { useSearchParams } from 'react-router';`
const raw = `${imported} const [query, setQuery] = useSearchParams(); setQuery(query)`
const site = { file: 'route.tsx', site: '[query, setQuery] = useSearchParams()' }
const exception = { ...site, reason: 'Preserve pushed file-selection history.' }

describe('raw query setter discipline (hearsay-tools/cezarion#1649)', () => {
  it.each(['setSearchParams', 'setQuery', 'write'])('detects a setter called %s', setter => {
    expect(scanSetters('route.tsx', `${imported} const [params, ${setter}] = useSearchParams(); ${setter}(params)`))
      .toEqual([{ file: 'route.tsx', site: `[params, ${setter}] = useSearchParams()` }])
  })

  it('detects renamed imports and namespace hooks, including multiline bindings', () => {
    expect(scanSetters('x.tsx', `import { useSearchParams as useQuery } from 'react-router-dom';
      const [params, send] =\n useQuery(); send(params)`)).toHaveLength(1)
    expect(scanSetters('x.tsx', `import * as Router from 'react-router';
      const [, send] = Router.useSearchParams(); send(new URLSearchParams())`)).toHaveLength(1)
  })

  it('detects retained tuples, rest bindings and setters passed without calling them', () => {
    for (const binding of ['tuple', '[params, ...rest]', '[...tuple]', '[params, send]']) {
      expect(scanSetters('x.tsx', `${imported} const ${binding} = useSearchParams()`)).toHaveLength(1)
    }
  })

  it('allows read-only hooks, the writer, unrelated setters, comments and fixture strings', () => {
    expect(scanSetters('x.tsx', `${imported}
      const [query] = useSearchParams();
      const [params, write] = useSearchParamsWriter(); write(params);
      const setSearchParams = (x: string) => x; setSearchParams('x');
      // const [p, setter] = useSearchParams()
      const fixture = 'const [p, setter] = useSearchParams()';`)).toEqual([])
    expect(scanSetters('x.tsx', `import { useSearchParams } from './other'; const [p, s] = useSearchParams()`)).toEqual([])
  })

  it('detects new sites, duplicate sites and stale exceptions', () => {
    expect(compareSetters([site], [])).toEqual({ added: [site], stale: [] })
    expect(compareSetters([site], [exception])).toEqual({ added: [], stale: [] })
    expect(compareSetters([site, site], [exception])).toEqual({ added: [site], stale: [] })
    expect(compareSetters([], [exception])).toEqual({ added: [], stale: [exception] })
  })

  it('scans nested source files, without reading non-source assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'query-discipline-'))
    try {
      mkdirSync(join(root, 'routes'))
      writeFileSync(join(root, 'routes/route.tsx'), raw)
      writeFileSync(join(root, 'fixture.json'), raw)
      expect(scanTree(root)).toEqual([{ ...site, file: 'routes/route.tsx' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps only the approved, reasoned file-selection exception; the baseline can shrink', () => {
    expect(baseline.sites.length).toBeLessThanOrEqual(1)
    for (const entry of baseline.sites) {
      expect(entry.file).toBe('routes/task-git/task-files.tsx')
      expect(entry.site).toBe('[query, setQuery] = useSearchParams()')
      expect(entry.reason.trim().length).toBeGreaterThan(0)
    }
  })
})
