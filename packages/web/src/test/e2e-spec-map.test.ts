// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { merge, partial } from '../../e2e/spec-map/build-map'
import { Bundle, assertSameJavaScript } from '../../e2e/spec-map/bundle'
import { WORKSPACE_PACKAGES, moduleFacts, resolveImport, type ModuleFacts } from '../../e2e/spec-map/module-graph'
import {
  buildMap, joinPartials, mapProblems, partialMap, reach, specStatuses,
  type SpecEvidence, type SpecMap,
} from '../../e2e/spec-map/spec-map'
import { captureBrowserArgs, compiledFunctions } from '../../e2e/spec-map/v8-log'
import specMapConfig from '../../e2e/spec-map/vitest.config'
import e2eConfig from '../../e2e/vitest.config'

// hearsay-tools/cezarion#1816: the map from cockpit sources to the browser specs that run them.

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-spec-map-'))
  roots.push(root)
  return root
}
function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('V8 function-event log', () => {
  it('turns on the log for one spec and keeps the caller’s own launch arguments', () => {
    expect(captureBrowserArgs('--lang=en', '/tmp/logs/smoke')).toBe(
      '--lang=en,--no-sandbox,--js-flags=--log-function-events --logfile=/tmp/logs/smoke/v8.log',
    )
    expect(captureBrowserArgs('', '/tmp/logs/smoke')).toBe(
      '--no-sandbox,--js-flags=--log-function-events --logfile=/tmp/logs/smoke/v8.log',
    )
    // agent-browser splits launch arguments on commas and newlines.
    expect(() => captureBrowserArgs('', '/tmp/a,b')).toThrow(/comma or newline/)
    expect(() => captureBrowserArgs('--js-flags=--expose-gc', '/tmp/logs')).toThrow(/already sets --js-flags/)
  })

  it('reads compiled functions of served scripts, whatever order the script names arrive in', () => {
    const log = [
      'v8-version,15,4,80,20,0',
      'function,preparse-no-resolution,4,13,28,0.017,358122,unused',
      'function,interpreter,4,0,143,0.087,359672,',
      'script-details,4,http://127.0.0.1:5000/assets/index-a.js,0,0,',
      'function,interpreter-lazy,4,78,94,0.008,360641,arrowUsed',
      'function,first-execution,4,13,28,0.001,360681,used',
      'script-details,5,chrome://internal.js,0,0,',
      'function,interpreter,5,10,20,0.001,1,',
      'function,interpreter,6,10,20,0.001,1,',
      'function,interpreter,4,x,20,0.001,1,',
    ].join('\n')
    expect(compiledFunctions(log)).toEqual([
      { url: 'http://127.0.0.1:5000/assets/index-a.js', start: 0, end: 143 },
      { url: 'http://127.0.0.1:5000/assets/index-a.js', start: 78, end: 94 },
      { url: 'http://127.0.0.1:5000/assets/index-a.js', start: 13, end: 28 },
    ])
  })
})

/**
 * A served script of two lines and its map: line 1 and the start of line 2 come from `a.tsx`,
 * line 2 from column 10 on from `b.ts`. Mappings: `AAAA` (a.tsx 1:0), `AACA` (a.tsx 2:0),
 * `UCAA` (column 10, b.ts 2:0).
 */
const SCRIPT = 'const a=1;\nfunction x(){return 1}function y(){return 2}\n'
function bundleFixture(root: string): Bundle {
  put(root, 'served/assets/x.js', SCRIPT)
  put(root, 'maps/assets/x.js', SCRIPT)
  put(root, 'maps/assets/x.js.map', JSON.stringify({
    version: 3,
    sources: ['../../packages/web/src/a.tsx', '../../packages/web/src/b.ts'],
    names: [],
    mappings: 'AAAA;AACA,UCAA',
  }))
  return new Bundle(join(root, 'served'), join(root, 'maps'), root)
}

describe('bundle', () => {
  it('maps a character offset of a served script to the repository file that wrote it', () => {
    const bundle = bundleFixture(tempRoot())
    expect(bundle.has('/assets/x.js')).toBe(true)
    expect(bundle.has('/assets/missing.js')).toBe(false)
    expect(bundle.sourcesOf('/assets/x.js')).toEqual(['packages/web/src/a.tsx', 'packages/web/src/b.ts'])
    expect(bundle.sourceAt('/assets/x.js', 2)).toBe('packages/web/src/a.tsx')
    expect(bundle.sourceAt('/assets/x.js', SCRIPT.indexOf('function x') + 2)).toBe('packages/web/src/a.tsx')
    expect(bundle.sourceAt('/assets/x.js', SCRIPT.indexOf('return 1') + 3)).toBe('packages/web/src/b.ts')
  })

  it('refuses a source-map build whose JavaScript differs from the served bundle, naming each file', () => {
    const root = tempRoot()
    put(root, 'served/assets/same.js', 'same')
    put(root, 'maps/assets/same.js', 'same')
    expect(() => assertSameJavaScript(join(root, 'served'), join(root, 'maps'))).not.toThrow()
    put(root, 'served/assets/changed.js', 'a')
    put(root, 'maps/assets/changed.js', 'b')
    put(root, 'served/only-served.js', 'x')
    put(root, 'maps/assets/only-mapped.js', 'y')
    expect(() => assertSameJavaScript(join(root, 'served'), join(root, 'maps'))).toThrow(
      /assets\/changed\.js: differs[\s\S]*only-served\.js: missing from the source-map build[\s\S]*assets\/only-mapped\.js: in the source-map build but not served/,
    )
    const empty = tempRoot()
    mkdirSync(join(empty, 'served'))
    mkdirSync(join(empty, 'maps'))
    expect(() => assertSameJavaScript(join(empty, 'served'), join(empty, 'maps'))).toThrow(/no JavaScript/)
  })
})

describe('module facts', () => {
  const facts = (text: string, path = 'packages/web/src/m.tsx'): ModuleFacts => moduleFacts(tempRoot(), path, text)

  it('marks a module that exports a runtime value other than a function', () => {
    expect(facts('export function a() {}\nexport const b = () => 1\nexport default function c() {}').exportsValue).toBe(false)
    expect(facts('export type A = string\nexport interface B {}\nexport type { C } from "./c"').exportsValue).toBe(false)
    expect(facts("export const CLASS = 'bg-row'").exportsValue).toBe(true)
    expect(facts('export const f = (() => 1) as () => number, LIMIT = 3').exportsValue).toBe(true)
    expect(facts('export class Store {}').exportsValue).toBe(true)
    expect(facts('export enum Mode { A }').exportsValue).toBe(true)
    expect(facts('export default { a: 1 }').exportsValue).toBe(true)
    expect(facts("export { a } from './a'").exportsValue).toBe(true)
    expect(facts("export * from './a'").exportsValue).toBe(true)
  })

  it('marks a module with a top-level statement that runs when its chunk loads', () => {
    const deferred = "import x from './x'\nconst a = 1, b = () => x()\nfunction f() { x() }\nclass C { field = x(); method() { x() } }"
    expect(facts(deferred).topLevelEffect).toBe(false)
    expect(facts("window.addEventListener('focus', () => {})").topLevelEffect).toBe(true)
    expect(facts('if (import.meta.env.DEV) console.log(1)').topLevelEffect).toBe(true)
  })

  it('marks a declaration that calls something at load, because the call can change state or throw for every loader', () => {
    for (const source of [
      "import x from './x'\nconst a = x()",
      "export const variants = cva('base')",
      'const seen = new Set()',
      'const html = String.raw`a`',
      'const table = { rows: [load()] }',
      'export default memo(View)',
      'export class Store { static instance = create() }',
      'class Store { static { init() } }',
    ]) expect(facts(source).topLevelEffect, source).toBe(true)
  })

  it('resolves the alias, relative paths and index files to repository paths, and skips packages and types', () => {
    const root = tempRoot()
    put(root, 'packages/web/src/lib/utils.ts', '')
    put(root, 'packages/web/src/components/diff/index.ts', '')
    put(root, 'packages/web/src/routes/view.tsx', '')
    const from = 'packages/web/src/routes/page.tsx'
    expect(resolveImport(root, from, '@/lib/utils')).toBe('packages/web/src/lib/utils.ts')
    expect(resolveImport(root, from, '../components/diff')).toBe('packages/web/src/components/diff/index.ts')
    expect(resolveImport(root, from, './view.js')).toBe('packages/web/src/routes/view.tsx')
    expect(resolveImport(root, from, 'react')).toBeNull()
    expect(resolveImport(root, from, './missing')).toBeNull()
    const page = moduleFacts(root, from, [
      "import { cn } from '@/lib/utils'",
      "import type { View } from './view'",
      "export { DiffView } from '../components/diff'",
    ].join('\n'))
    expect(page.imports).toEqual(['packages/web/src/components/diff/index.ts', 'packages/web/src/lib/utils.ts'])
  })

  it('resolves the workspace packages the cockpit bundles to their source files', () => {
    const root = tempRoot()
    put(root, 'packages/api-client/src/index.ts', '')
    put(root, 'packages/api-client/src/contract/defined.ts', '')
    put(root, 'packages/contract/src/waits.ts', '')
    const from = 'packages/web/src/routes/page.tsx'
    expect(resolveImport(root, from, '@open-mercato/cezar-api-client')).toBe('packages/api-client/src/index.ts')
    expect(resolveImport(root, from, '@open-mercato/cezar-api-client/contract/defined')).toBe('packages/api-client/src/contract/defined.ts')
    expect(resolveImport(root, 'packages/api-client/src/index.ts', '@open-mercato/cezar-contract/waits')).toBe('packages/contract/src/waits.ts')
    expect(resolveImport(root, from, '@open-mercato/cezar-contractual')).toBeNull()
  })

  it('names every workspace package the cockpit bundle depends on, with the export pattern it resolves', () => {
    const repo = resolve(import.meta.dirname, '../../../..')
    const manifest = (dir: string) => JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8'))
    const workspaces = new Map(readdirSync(join(repo, 'packages')).map((dir) => [manifest(`packages/${dir}`).name as string, `packages/${dir}`]))
    const bundled = ['packages/web', 'packages/api-client']
      .flatMap((dir) => Object.keys(manifest(dir).dependencies ?? {}))
      .filter((name) => workspaces.has(name))
    expect(WORKSPACE_PACKAGES.map(([name]) => name).sort()).toEqual([...new Set(bundled)].sort())
    for (const [name, source] of WORKSPACE_PACKAGES) {
      expect(source).toBe(`${workspaces.get(name)}/src`)
      expect(manifest(workspaces.get(name)!).exports).toMatchObject({ '.': './src/index.ts', './*': './src/*.ts' })
    }
  })
})

const evidence = (status: 'passed' | 'failed', executed: string[], loaded: string[] = executed): SpecEvidence =>
  ({ status, executed, loaded })
const plain: ModuleFacts = { imports: [], exportsValue: false, topLevelEffect: false }

describe('spec reach', () => {
  const specs = ['a.e2e.ts', 'b.e2e.ts', 'c.e2e.ts']
  const all = ['app.tsx', 'styles.ts', 'barrel.ts', 'view.tsx', 'effect.ts', 'unused.tsx']

  it('credits a file to the specs that ran it, its importers’ specs when it exports a value, and loaders when it has a top-level statement', () => {
    const run: Record<string, SpecEvidence> = {
      'a.e2e.ts': evidence('passed', ['app.tsx'], all),
      'b.e2e.ts': evidence('passed', ['view.tsx'], all),
      'c.e2e.ts': evidence('passed', ['app.tsx'], all),
    }
    const graph = new Map<string, ModuleFacts>([
      ['app.tsx', { ...plain, imports: ['barrel.ts'] }],
      // A constant reaches `view.tsx` through a barrel.
      ['styles.ts', { ...plain, exportsValue: true }],
      ['barrel.ts', { ...plain, imports: ['styles.ts'], exportsValue: true }],
      ['view.tsx', { ...plain, imports: ['barrel.ts'] }],
      ['effect.ts', { ...plain, topLevelEffect: true }],
      ['unused.tsx', plain],
    ])
    const result = reach(specs, run, graph)
    expect([...(result.get('app.tsx') ?? [])].sort()).toEqual([0, 2])
    expect([...(result.get('view.tsx') ?? [])]).toEqual([1])
    expect([...(result.get('barrel.ts') ?? [])].sort()).toEqual([0, 1, 2])
    expect([...(result.get('styles.ts') ?? [])].sort()).toEqual([0, 1, 2])
    expect([...(result.get('effect.ts') ?? [])].sort()).toEqual([0, 1, 2])
    expect([...(result.get('unused.tsx') ?? [])]).toEqual([])
  })

  it('builds the map with sorted indexes and lists failed specs and specs without evidence as incomplete', () => {
    const run = {
      'b.e2e.ts': evidence('failed', ['app.tsx']),
      'a.e2e.ts': evidence('passed', ['app.tsx'], ['app.tsx', 'unused.tsx']),
      'c.e2e.ts': evidence('passed', []),
    }
    const map = buildMap(run, new Map([['app.tsx', plain]]), 'f'.repeat(40), '2026-10-26T00:00:00.000Z')
    expect(map).toEqual({
      version: 1,
      commit: 'f'.repeat(40),
      createdAt: '2026-10-26T00:00:00.000Z',
      specs: ['a.e2e.ts', 'b.e2e.ts', 'c.e2e.ts'],
      incomplete: ['b.e2e.ts', 'c.e2e.ts'],
      sources: { 'app.tsx': [0, 1], 'unused.tsx': [] },
    })
  })

  it('refuses shards that ran a spec twice or left a spec out', () => {
    const shard = (spec: string) => ({ version: 1 as const, specs: { [spec]: evidence('passed', []) } })
    expect(Object.keys(joinPartials([shard('a.e2e.ts'), shard('b.e2e.ts')], ['a.e2e.ts', 'b.e2e.ts']))).toEqual(['a.e2e.ts', 'b.e2e.ts'])
    expect(() => joinPartials([shard('a.e2e.ts'), shard('a.e2e.ts')], ['a.e2e.ts'])).toThrow(/two capture shards/)
    expect(() => joinPartials([shard('a.e2e.ts')], ['a.e2e.ts', 'b.e2e.ts'])).toThrow(/no capture shard ran b\.e2e\.ts/)
  })
})

describe('map validation', () => {
  const map = (incomplete: string[], sources: Record<string, number[]>): SpecMap => ({
    version: 1, commit: 'f'.repeat(40), createdAt: '', specs: ['a.e2e.ts', 'b.e2e.ts'], incomplete, sources,
  })
  const expectation = [{ source: 'markdown.tsx', spec: 'b.e2e.ts' }]

  it('passes a map that keeps a known source-to-spec pair', () => {
    expect(mapProblems(map([], { 'markdown.tsx': [1] }), expectation, 0.9)).toEqual([])
  })

  it('refuses a map whose capture left too little evidence or lost a known pair', () => {
    expect(mapProblems(map(['a.e2e.ts'], { 'markdown.tsx': [1] }), [], 0.9)).toEqual([
      'only 1 of 2 specs left V8 evidence (need 90%)',
    ])
    expect(mapProblems(map([], { 'markdown.tsx': [0] }), expectation, 0.9)).toEqual(['markdown.tsx does not reach b.e2e.ts'])
    expect(mapProblems(map([], {}), [{ source: 'x.tsx', spec: 'z.e2e.ts' }], 0.9)).toEqual(['expected spec z.e2e.ts did not run'])
  })

  it('does not hold a known pair against a spec whose own run failed', () => {
    expect(mapProblems(map(['b.e2e.ts'], {}), expectation, 0.5)).toEqual([])
  })
})

describe('shard capture', () => {
  it('reads statuses from the Vitest JSON report as repository paths', () => {
    const statuses = specStatuses({ testResults: [
      { name: '/repo/packages/web/e2e/a.e2e.ts', status: 'passed' },
      { name: '/repo/packages/web/e2e/b.e2e.ts', status: 'failed' },
      { name: '/elsewhere/c.e2e.ts', status: 'passed' },
    ] }, '/repo')
    expect([...statuses]).toEqual([['packages/web/e2e/a.e2e.ts', 'passed'], ['packages/web/e2e/b.e2e.ts', 'failed']])
    expect(() => specStatuses({}, '/repo')).toThrow(/no testResults/)
  })

  it('turns one spec’s V8 logs into the files it ran and loaded, ignoring the script itself and foreign scripts', () => {
    const root = tempRoot()
    const bundle = bundleFixture(root)
    const at = SCRIPT.indexOf('function y') + 10
    put(root, 'logs/a/isolate-1-v8.log', [
      'script-details,7,http://127.0.0.1:41000/assets/x.js,0,0,',
      `function,interpreter,7,0,${SCRIPT.length},0.1,1,`,
      `function,interpreter-lazy,7,${at},${at + 10},0.1,2,y`,
      'script-details,8,http://127.0.0.1:41000/other.js,0,0,',
      'function,interpreter-lazy,8,3,9,0.1,3,z',
    ].join('\n'))
    const statuses = new Map([['packages/web/e2e/a.e2e.ts', 'passed' as const], ['packages/web/e2e/b.e2e.ts', 'failed' as const]])
    expect(partialMap(join(root, 'logs'), statuses, bundle)).toEqual({
      version: 1,
      specs: {
        'packages/web/e2e/a.e2e.ts': {
          status: 'passed', executed: ['packages/web/src/b.ts'], loaded: ['packages/web/src/a.tsx', 'packages/web/src/b.ts'],
        },
        'packages/web/e2e/b.e2e.ts': { status: 'failed', executed: [], loaded: [] },
      },
    })
    expect(() => partialMap(join(root, 'logs'), new Map(), bundle)).toThrow(/names no spec/)
  })
})

describe('capture config', () => {
  it('runs the e2e suite unchanged plus the capture setup file', () => {
    const base = e2eConfig.test!
    const capture = specMapConfig.test!
    expect(capture.include).toEqual(base.include)
    expect(capture.root).toBe(base.root)
    expect(capture.globalSetup).toEqual(base.globalSetup)
    expect(capture.sequence).toEqual(base.sequence)
    expect(capture.fileParallelism).toBe(false)
    const setup = capture.setupFiles as string[]
    expect(setup.slice(0, -1)).toEqual(base.setupFiles)
    expect(setup.at(-1)).toMatch(/\/e2e\/spec-map\/capture-setup\.ts$/)
  })
})

describe('build-map commands', () => {
  const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

  it('partial writes one shard’s evidence after it checks the source-map build', () => {
    const root = tempRoot()
    bundleFixture(root)
    put(root, 'logs/a/isolate-1-v8.log', [
      'script-details,7,http://127.0.0.1:41000/assets/x.js,0,0,',
      `function,interpreter-lazy,7,${SCRIPT.indexOf('return 1') + 3},30,0.1,2,x`,
    ].join('\n'))
    put(root, 'results.json', JSON.stringify({ testResults: [{ name: join(root, 'packages/web/e2e/a.e2e.ts'), status: 'passed' }] }))
    const args = ['--logs', join(root, 'logs'), '--served', join(root, 'served'), '--sourcemaps', join(root, 'maps'),
      '--results', join(root, 'results.json'), '--out', join(root, 'out/shard-1.json')]
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    partial(args, root)
    expect(readJson(join(root, 'out/shard-1.json'))).toEqual({ version: 1, specs: {
      'packages/web/e2e/a.e2e.ts': { status: 'passed', executed: ['packages/web/src/b.ts'], loaded: ['packages/web/src/a.tsx', 'packages/web/src/b.ts'] },
    } })
    expect(log).toHaveBeenCalledWith('spec map: 1 of 1 specs left V8 evidence')
    put(root, 'maps/assets/x.js', `${SCRIPT}// rebuilt\n`)
    expect(() => partial(args, root)).toThrow(/assets\/x\.js: differs from the source-map build/)
    expect(() => partial(args.slice(2), root)).toThrow(/partial needs --logs/)
  })

  it('merge publishes a map only when every spec ran and each expected pair holds', () => {
    const root = tempRoot()
    put(root, 'packages/web/e2e/a.e2e.ts', '')
    put(root, 'packages/web/e2e/b.e2e.ts', '')
    put(root, 'packages/web/src/a.tsx', 'export function A() {}')
    put(root, 'packages/web/src/b.ts', "export const B = 'b'")
    const shard = (spec: string, executed: string[]) => JSON.stringify({ version: 1, specs: { [spec]: evidence('passed', executed, ['packages/web/src/a.tsx', 'packages/web/src/b.ts']) } })
    put(root, 'partials/e2e-spec-map-partial-1/shard-1.json', shard('packages/web/e2e/a.e2e.ts', ['packages/web/src/a.tsx']))
    put(root, 'partials/e2e-spec-map-partial-2/shard-2.json', shard('packages/web/e2e/b.e2e.ts', ['packages/web/src/b.ts']))
    const commit = 'c'.repeat(40)
    const run = (...extra: string[]) => merge(['--partials', join(root, 'partials'), '--commit', commit, '--out', join(root, 'map.json'), ...extra], root)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    run('--expect', 'packages/web/src/a.tsx=packages/web/e2e/a.e2e.ts')
    expect(readJson(join(root, 'map.json'))).toMatchObject({
      version: 1, commit, specs: ['packages/web/e2e/a.e2e.ts', 'packages/web/e2e/b.e2e.ts'], incomplete: [],
      sources: { 'packages/web/src/a.tsx': [0], 'packages/web/src/b.ts': [1] },
    })
    expect(() => run('--expect', 'packages/web/src/a.tsx=packages/web/e2e/b.e2e.ts')).toThrow(
      /the spec map is not published:\n {2}packages\/web\/src\/a\.tsx does not reach packages\/web\/e2e\/b\.e2e\.ts/,
    )
    expect(() => run('--expect', 'packages/web/src/a.tsx')).toThrow(/--expect takes <source>=<spec>/)
    put(root, 'packages/web/e2e/c.e2e.ts', '')
    expect(() => run()).toThrow(/no capture shard ran packages\/web\/e2e\/c\.e2e\.ts/)
    expect(() => merge(['--partials', join(root, 'partials'), '--commit', 'main', '--out', join(root, 'map.json')], root)).toThrow(/full commit id/)
    expect(() => merge(['--commit', commit], root)).toThrow(/merge needs --partials/)
  })
})
