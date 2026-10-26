// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  baselinePath,
  compareToBaseline,
  FLOOR_MS,
  readBaseline,
  scanSource,
  scanTree,
  shrinkBaseline,
  tally,
  writeBaseline,
  type BaselineEntry,
  type Site,
} from './unit-wait-discipline'

/**
 * The cockpit unit tests' wait discipline, as a syntax-tree scan (hearsay-tools/cezarion#1203). A Vitest wait
 * with no bound gives up after 1 s, a bare sleep stands in for a condition nobody named, and a poll loop
 * with no deadline waits as long as the test lets it. Each rule is pinned on a snippet here, flagged and
 * accepted, and the suite's real sites are pinned in a baseline that can only shrink: the cockpit twin of
 * `packages/cezar/src/test-wait-discipline.test.ts`.
 */
const scan = (...lines: string[]): Site[] => scanSource('x.test.tsx', lines.join('\n'))
const rules = (...lines: string[]) => scan(...lines).map(site => site.rule)
const tlImport = `import { waitFor, waitForElementToBeRemoved, screen } from '@testing-library/react'`

describe('rule short-bound: Vitest waits', () => {
  it('flags a wait with no bound: Vitest ends it after 1 s', () => {
    expect(rules('await vi.waitFor(() => expect(ok()).toBe(true))')).toEqual(['short-bound'])
    expect(rules('await vi.waitUntil(() => ok())')).toEqual(['short-bound'])
    expect(rules('await expect.poll(() => value()).toBe(1)')).toEqual(['short-bound'])
  })

  it('flags an option object that sets no timeout', () => {
    expect(rules('await vi.waitFor(() => ok(), { interval: 10 })')).toEqual(['short-bound'])
    expect(rules('await expect.poll(() => value(), { interval: 10 }).toBe(1)')).toEqual(['short-bound'])
  })

  it('flags a literal bound under the floor, as an option or as a number', () => {
    expect(rules('await vi.waitFor(() => ok(), { timeout: 2_999 })')).toEqual(['short-bound'])
    expect(rules('await vi.waitFor(() => ok(), { timeout: 500, interval: 10 })')).toEqual(['short-bound'])
    expect(rules('await vi.waitFor(() => ok(), 2000)')).toEqual(['short-bound'])
    expect(rules('await expect.poll(() => value(), { timeout: 1000 }).toBe(1)')).toEqual(['short-bound'])
  })

  it('flags a bound held in a same-file constant', () => {
    expect(rules('const SHORT = 500', 'await vi.waitFor(() => ok(), { timeout: SHORT })')).toEqual(['short-bound'])
    expect(rules('const SHORT = 1_000 * 2', 'await vi.waitFor(() => ok(), SHORT)')).toEqual(['short-bound'])
  })

  it('accepts a bound at or above the floor, however it is spelled', () => {
    expect(rules('await vi.waitFor(() => ok(), { timeout: 3_000 })')).toEqual([])
    expect(rules('await vi.waitFor(() => ok(), 5_000)')).toEqual([])
    expect(rules('await expect.poll(() => value(), { timeout: 60 * 1_000 }).toBe(1)')).toEqual([])
    expect(rules('const GUARD = 15_000', 'await vi.waitUntil(() => ok(), { timeout: GUARD })')).toEqual([])
  })

  it('leaves a bound it cannot read alone', () => {
    expect(rules('await vi.waitFor(() => ok(), { timeout })')).toEqual([])
    expect(rules('await vi.waitFor(() => ok(), { timeout: limit() })')).toEqual([])
    expect(rules('await vi.waitFor(() => ok(), options)')).toEqual([])
    expect(rules("import { LIMIT } from './limits'", 'await vi.waitFor(() => ok(), { timeout: LIMIT })')).toEqual([])
  })

  it('ignores a wait of another object, and waits written in strings or comments', () => {
    expect(rules('await queue.waitFor(() => ok())')).toEqual([])
    expect(rules('await expectation.poll(() => ok())')).toEqual([])
    expect(rules("const text = 'await vi.waitFor(() => ok())'", '// await vi.waitFor(() => ok())')).toEqual([])
  })
})

describe('rule short-bound: Testing Library waits', () => {
  it('flags a literal timeout under the floor on waitFor and waitForElementToBeRemoved', () => {
    expect(rules(tlImport, 'await waitFor(() => expect(screen.getByText("x")).toBeTruthy(), { timeout: 500 })')).toEqual(['short-bound'])
    expect(rules(tlImport, 'await waitForElementToBeRemoved(() => screen.queryByText("x"), { timeout: 2_000 })')).toEqual(['short-bound'])
    expect(rules(`import { waitFor as eventually } from '@testing-library/react'`, 'await eventually(() => ok(), { timeout: 1_000 })')).toEqual(['short-bound'])
  })

  it('flags a literal timeout under the floor on findBy and findAllBy, which take it as the last options', () => {
    expect(rules(tlImport, 'await screen.findByText("x", {}, { timeout: 500 })')).toEqual(['short-bound'])
    expect(rules(tlImport, 'await screen.findAllByRole("row", { name: "y" }, { timeout: 1_000 })')).toEqual(['short-bound'])
    expect(rules('const { findByLabelText } = render(<A />)', 'await findByLabelText("x", {}, { timeout: 100 })')).toEqual(['short-bound'])
  })

  it('accepts a wait with no timeout: asyncUtilTimeout covers it', () => {
    expect(rules(tlImport, 'await waitFor(() => ok())')).toEqual([])
    expect(rules(tlImport, 'await screen.findByRole("button", { name: "Save" })')).toEqual([])
    expect(rules(tlImport, 'await waitForElementToBeRemoved(() => screen.queryByText("x"))')).toEqual([])
  })

  it('accepts a timeout at the floor or above, or one it cannot read', () => {
    expect(rules(tlImport, 'await waitFor(() => ok(), { timeout: 3_000 })')).toEqual([])
    expect(rules(tlImport, 'await screen.findByText("x", {}, { timeout: 10_000 })')).toEqual([])
    expect(rules(tlImport, 'await waitFor(() => ok(), { timeout: budget })')).toEqual([])
  })

  it('ignores a local waitFor helper, which is not Testing Library', () => {
    expect(rules('const waitFor = async (fn) => fn()', 'await waitFor(() => ok(), { timeout: 100 })')).toEqual([])
  })
})

describe('rule sleep', () => {
  it('flags an awaited timer however the promise is spelled', () => {
    expect(rules('await new Promise(resolve => setTimeout(resolve, 50))')).toEqual(['sleep'])
    expect(rules('await new Promise<void>((resolve) => { setTimeout(resolve, 50) })')).toEqual(['sleep'])
    expect(rules('await new Promise(function (done) { setTimeout(done, 50) })')).toEqual(['sleep'])
    expect(rules('await new Promise(resolve => window.setTimeout(resolve, 50))')).toEqual(['sleep'])
    expect(rules('await new Promise(resolve => realSetTimeout(resolve, 50))')).toEqual(['sleep'])
  })

  it('flags a named sleep helper and the promisified timer', () => {
    for (const name of ['sleep', 'delay', 'wait', 'pause']) expect(rules(`await ${name}(10)`)).toEqual(['sleep'])
    expect(rules('await setTimeout(10)')).toEqual(['sleep'])
    expect(rules('await timers.setTimeout(10)')).toEqual(['sleep'])
  })

  it('flags a sleep whose delay it cannot read, and a sleep inside act()', () => {
    expect(rules('await sleep(ms)')).toEqual(['sleep'])
    expect(scan('await act(async () => {', '  await new Promise(resolve => setTimeout(resolve, 450))', '})').map(site => site.line)).toEqual([2])
  })

  it('accepts a delay of 0, which is one event-loop turn', () => {
    expect(rules('await new Promise(resolve => setTimeout(resolve, 0))')).toEqual([])
    expect(rules('await sleep(0)')).toEqual([])
  })

  it('ignores a timer that is not awaited, or does not resolve the promise it is awaited in', () => {
    expect(rules('setTimeout(() => done(), 50)')).toEqual([])
    expect(rules('const later = new Promise(resolve => setTimeout(resolve, 50))')).toEqual([])
    expect(rules('await new Promise(resolve => setTimeout(() => {}, 50))')).toEqual([])
    expect(rules('await vi.advanceTimersByTimeAsync(50)')).toEqual([])
    expect(rules("const text = 'await sleep(10)'", '// await sleep(10)')).toEqual([])
  })

  it('reports a sleep in a loop over a collection as a sleep: its iterable bounds the loop, not the wait', () => {
    expect(rules('for (const x of xs) await sleep(10)')).toEqual(['sleep'])
    expect(rules('for (const k in obj) { await sleep(10) }')).toEqual(['sleep'])
    expect(rules('for await (const chunk of stream) { await pause(5) }')).toEqual(['sleep'])
  })

  it('reports a sleep in a callback as a sleep: a loop around the callback does not bound it', () => {
    expect(rules('while (open()) { items.forEach(async () => { await sleep(1) }) }')).toEqual(['sleep'])
    expect(rules('for (let i = 0; i < 3; i++) { it("case", async () => { await sleep(1) }) }')).toEqual(['sleep'])
  })
})

describe('rule poll-deadline', () => {
  it('flags a loop that nothing bounds', () => {
    expect(rules('while (!ready()) { await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('for (;;) { if (ready()) break; await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('do { await sleep(10) } while (!ready())')).toEqual(['poll-deadline'])
  })

  it('reports the loop once, at its head, however many sleeps it holds', () => {
    const sites = scan('const start = 1', 'while (!ready()) {', '  await sleep(10)', '  if (more()) await sleep(20)', '}')
    expect(sites.map(site => [site.rule, site.line, site.site])).toEqual([['poll-deadline', 2, 'while (!ready()) {']])
  })

  it('reports only the innermost loop of a nest', () => {
    expect(scan('while (a()) {', '  while (!b()) { await sleep(10) }', '}').map(site => site.line)).toEqual([2])
  })

  it('flags a clock bound under the floor in each form', () => {
    expect(rules('const start = Date.now()', 'while (!ready()) { if (Date.now() - start > 1_000) throw new Error("late"); await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('const end = Date.now() + 2_000', 'while (Date.now() < end && !ready()) await sleep(10)')).toEqual(['poll-deadline'])
    expect(rules('for (const end = Date.now() + 2_999; !ready() && Date.now() < end;) await sleep(10)')).toEqual(['poll-deadline'])
    expect(rules('const start = performance.now()', 'while (!ready() && performance.now() < start + 1_500) await sleep(10)')).toEqual(['poll-deadline'])
  })

  it('accepts a clock bound at the floor or above', () => {
    expect(rules('const start = Date.now()', 'while (!ready()) { if (Date.now() - start > 5_000) throw new Error("late"); await sleep(10) }')).toEqual([])
    expect(rules('const end = Date.now() + 3_000', 'while (Date.now() < end) await sleep(10)')).toEqual([])
    expect(rules('for (const end = Date.now() + 15_000; !ready() && Date.now() < end;) await sleep(10)')).toEqual([])
  })

  it('resolves a bound through a parameter default or a same-file constant', () => {
    expect(rules('async function until(check, ms = 500) {', '  const end = Date.now() + ms', '  while (!check() && Date.now() < end) await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('async function until(check, ms = 15_000) {', '  const end = Date.now() + ms', '  while (!check() && Date.now() < end) await sleep(10)', '}')).toEqual([])
    expect(rules('const LIMIT = 800', 'const end = Date.now() + LIMIT', 'while (!ready() && Date.now() < end) await sleep(10)')).toEqual(['poll-deadline'])
  })

  it('leaves a bound it cannot read alone', () => {
    expect(rules('async function until(check, ms) {', '  const end = Date.now() + ms', '  while (!check() && Date.now() < end) await sleep(10)', '}')).toEqual([])
    expect(rules('while (!ready() && Date.now() < CEILING) await sleep(10)')).toEqual([])
    expect(rules("import { CEILING } from './limits'", 'const end = Date.now() + CEILING', 'while (!ready() && Date.now() < end) await sleep(10)')).toEqual([])
  })

  it('does not take a clock read outside the loop for its bound', () => {
    expect(rules('const t0 = Date.now()', 'while (!ready()) { if (elapsed()) break; await sleep(10) }')).toEqual(['poll-deadline'])
  })

  it('counts attempts when the count and every delay are literals: count times interval is the deadline', () => {
    expect(rules('for (let i = 0; i < 20; i++) { if (ready()) break; await sleep(50) }')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 59; i += 1) { if (ready()) break; await sleep(50) }')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 60; i++) { if (ready()) break; await sleep(50) }')).toEqual([])
    expect(rules('for (let i = 0; i <= 59; i++) { if (ready()) break; await sleep(50) }')).toEqual([])
    expect(rules('for (let i = 1; i < 21; i++) { if (ready()) break; await sleep(50) }')).toEqual(['poll-deadline'])
  })

  it('sums the delays of the loop when it holds more than one sleep', () => {
    expect(rules('for (let i = 0; i < 20; i++) { await sleep(50); if (ready()) break; await sleep(100) }')).toEqual([])
    expect(rules('for (let i = 0; i < 10; i++) { await sleep(50); if (ready()) break; await sleep(100) }')).toEqual(['poll-deadline'])
  })

  it('treats any other attempt count as a bound it cannot read', () => {
    expect(rules('for (let i = 0; i < attempts; i++) { if (ready()) break; await sleep(50) }')).toEqual([])
    expect(rules('for (let i = 0; i < 20; i++) { if (ready()) break; await sleep(interval) }')).toEqual([])
    expect(rules('for (let i = 20; i > 0; i--) { if (ready()) break; await sleep(50) }')).toEqual([])
    expect(rules('while (retries-- > 0) { await sleep(10) }')).toEqual([])
    expect(rules('let n = 0', 'while (n < 20) { n += 1; await sleep(50) }')).toEqual([])
  })

  it('leaves a loop that reads the clock but never compares it to a bound it can read', () => {
    expect(rules('while (!ready()) { log(Date.now()); await sleep(10) }')).toEqual([])
  })

  it('does not read a clock or a comparison written in a string or a comment', () => {
    expect(rules('while (!ready()) {', '  // if (Date.now() - start > 15_000) throw new Error("late")', '  const text = "Date.now()"', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
  })

  it('reports a polling loop as a poll, not also as a sleep', () => {
    expect(scan('while (!ready()) { await sleep(10) }', 'await sleep(10)').map(site => [site.rule, site.line])).toEqual([['poll-deadline', 1], ['sleep', 2]])
  })
})

describe('// bound: <reason>', () => {
  it('accepts a site on its own line or in the comment block directly above it', () => {
    expect(rules('await sleep(10) // bound: negative window, the refusal above is synchronous')).toEqual([])
    expect(rules('// bound: negative window, the refusal above is synchronous', 'await sleep(10)')).toEqual([])
    expect(rules('// Give a stampede every chance to happen.', '// bound: negative window.', '// The pump runs in one turn.', 'await sleep(10)')).toEqual([])
  })

  it('accepts each kind of site', () => {
    expect(rules('// bound: the fake holds the call open', 'await vi.waitFor(() => ok(), { timeout: 100 })')).toEqual([])
    expect(rules('// bound: a load generator, not a poll', 'while (churning) { await sleep(15) }')).toEqual([])
    expect(rules(tlImport, 'await waitFor(() => gone(), { timeout: 200 }) // bound: asserts it does not reappear')).toEqual([])
  })

  it('needs a reason, and does not take a block comment', () => {
    expect(rules('// bound:', 'await sleep(10)')).toEqual(['sleep'])
    expect(rules('/* bound: negative window */', 'await sleep(10)')).toEqual(['sleep'])
    expect(rules("const text = '// bound: reason'", 'await sleep(10)')).toEqual(['sleep'])
  })

  it('does not reach past a blank line, a code line or a neighbouring site', () => {
    expect(rules('// bound: negative window', '', 'await sleep(10)')).toEqual(['sleep'])
    expect(rules('// bound: negative window', 'ready()', 'await sleep(10)')).toEqual(['sleep'])
    expect(rules('await sleep(10) // bound: negative window', 'await sleep(20)')).toEqual(['sleep'])
  })
})

describe('the floor', () => {
  it('is the asyncUtilTimeout the cockpit setup configures: a Testing Library wait below it is shorter than the host default', () => {
    const setup = readFileSync(resolve(import.meta.dirname, '../../vitest.setup.ts'), 'utf8')
    const configured = /asyncUtilTimeout:\s*([\d_]+)/.exec(setup)?.[1]
    expect(Number(configured?.replaceAll('_', ''))).toBe(FLOOR_MS)
  })
})

describe('the baseline', () => {
  const entry = (site: string, count = 1, rule: BaselineEntry['rule'] = 'sleep'): BaselineEntry => ({ file: 'a.test.ts', rule, site, count })

  it('counts a repeated site once with its count, sorted by file, rule and site', () => {
    const sites: Site[] = [
      { file: 'b.test.ts', rule: 'sleep', site: 'await sleep(1)', line: 1 },
      { file: 'a.test.ts', rule: 'sleep', site: 'await sleep(1)', line: 9 },
      { file: 'a.test.ts', rule: 'sleep', site: 'await sleep(1)', line: 3 },
      { file: 'a.test.ts', rule: 'short-bound', site: 'await vi.waitFor(ok)', line: 5 },
    ]
    expect(tally(sites)).toEqual([
      { file: 'a.test.ts', rule: 'short-bound', site: 'await vi.waitFor(ok)', count: 1 },
      { file: 'a.test.ts', rule: 'sleep', site: 'await sleep(1)', count: 2 },
      { file: 'b.test.ts', rule: 'sleep', site: 'await sleep(1)', count: 1 },
    ])
  })

  it('finds a new site, a known site seen more often than recorded, and a site that is gone', () => {
    expect(compareToBaseline([entry('a')], [])).toEqual({ added: [entry('a')], stale: [] })
    expect(compareToBaseline([entry('a', 3)], [entry('a', 1)])).toEqual({ added: [entry('a', 2)], stale: [] })
    expect(compareToBaseline([entry('a', 1)], [entry('a', 2)])).toEqual({ added: [], stale: [entry('a', 2)] })
    expect(compareToBaseline([], [entry('a')])).toEqual({ added: [], stale: [entry('a')] })
    expect(compareToBaseline([entry('a')], [entry('a')])).toEqual({ added: [], stale: [] })
  })

  it('writes the first baseline when the file is missing, and afterwards only lowers it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unit-wait-discipline-'))
    const path = join(dir, 'baseline.json')
    try {
      expect(readBaseline(path)).toEqual([])
      shrinkBaseline([entry('a', 2), entry('b')], path)
      expect(readBaseline(path)).toEqual([entry('a', 2), entry('b')])
      shrinkBaseline([entry('a', 1), entry('c', 5)], path)
      expect(readBaseline(path)).toEqual([entry('a', 1)])
      writeBaseline([], path)
      shrinkBaseline([entry('a')], path)
      expect(readBaseline(path)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scans nested test files, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unit-wait-discipline-'))
    const sleep = 'await new Promise(resolve => setTimeout(resolve, 50))'
    try {
      mkdirSync(join(dir, 'routes'))
      mkdirSync(join(dir, 'node_modules'))
      writeFileSync(join(dir, 'routes/a.test.tsx'), sleep)
      writeFileSync(join(dir, 'routes/helper.ts'), sleep)
      writeFileSync(join(dir, 'node_modules/b.test.ts'), sleep)
      writeFileSync(join(dir, 'fixture.json'), sleep)
      expect(scanTree(dir)).toEqual([{ file: 'routes/a.test.tsx', rule: 'sleep', site: sleep, line: 1 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('has no wait-discipline site outside the baseline, and the baseline names no site that is gone', () => {
    const actual = tally(scanTree())
    // Update mode shrinks the baseline to what the tests have now; it never adds to it.
    if (process.env.UNIT_WAIT_DISCIPLINE_UPDATE === '1') shrinkBaseline(actual)
    const { added, stale } = compareToBaseline(actual, readBaseline())
    const describeEntries = (entries: BaselineEntry[]) => entries.map(e => `  ${e.file} [${e.rule}] x${e.count}: ${e.site}`).join('\n')
    expect(
      added,
      `New wait-discipline sites. Give each a product signal, a bound of at least ${FLOOR_MS} ms, or a "// bound: <reason>" comment, rather than adding it to ${baselinePath}:\n${describeEntries(added)}`,
    ).toEqual([])
    expect(
      stale,
      `Baseline entries no longer found; shrink ${baselinePath} (UNIT_WAIT_DISCIPLINE_UPDATE=1 npm test -- unit-wait-discipline does it):\n${describeEntries(stale)}`,
    ).toEqual([])
  })
})
