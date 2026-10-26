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

  it('takes the last timeout of an option object, as the language does, and no bound from a constant that is assigned again', () => {
    expect(rules('await vi.waitFor(() => ok(), { timeout: 10_000, timeout: 500 })')).toEqual(['short-bound'])
    expect(rules('await vi.waitFor(() => ok(), { timeout: 500, timeout: 10_000 })')).toEqual([])
    expect(rules('let SHORT = 500', 'SHORT = 5_000', 'await vi.waitFor(() => ok(), { timeout: SHORT })')).toEqual([])
    expect(rules('let SHORT = 500', 'await vi.waitFor(() => ok(), { timeout: SHORT })')).toEqual(['short-bound'])
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
    expect(rules(`import * as rtl from '@testing-library/react'`, 'await rtl.waitFor(() => ok(), { timeout: 500 })')).toEqual(['short-bound'])
    expect(rules(`import * as rtl from '@testing-library/react'`, 'await rtl.waitFor(() => ok(), { timeout: 5_000 })')).toEqual([])
    expect(rules(`import * as other from './helpers'`, 'await other.waitFor(() => ok(), { timeout: 500 })')).toEqual([])
    expect(rules(tlImport, 'await waitFor(() => ok(), { timeout: 2 * 1000 })')).toEqual(['short-bound'])
    expect(rules(tlImport, 'await waitFor(() => ok(), { timeout: 30_000 / 20 })')).toEqual(['short-bound'])
    expect(rules(tlImport, 'await waitFor(() => ok(), { timeout: 3 * 1000 })')).toEqual([])
  })

  it('flags a literal timeout under the floor on findBy and findAllBy, which take it as the last options', () => {
    expect(rules(tlImport, 'await screen.findByText("x", {}, { timeout: 500 })')).toEqual(['short-bound'])
    expect(rules(tlImport, 'await screen.findAllByRole("row", { name: "y" }, { timeout: 1_000 })')).toEqual(['short-bound'])
    expect(rules('const { findByLabelText } = render(<A />)', 'await findByLabelText("x", {}, { timeout: 100 })')).toEqual(['short-bound'])
  })

  it('takes the last options object that sets a timeout: it is the wait\'s own', () => {
    expect(rules(tlImport, 'await screen.findByText("x", { timeout: 5_000 }, { timeout: 500 })')).toEqual(['short-bound'])
    expect(rules(tlImport, 'await screen.findByText("x", { timeout: 500 }, { timeout: 5_000 })')).toEqual([])
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

  it('reads the declaration nearest the loop, not the first one with that name in the function', () => {
    const poll = ['  while (!ready() && Date.now() < end) await sleep(10)', '}']
    // A helper's own `end` is another function's name.
    expect(rules('async function run() {', '  const helper = () => { const end = Date.now() + 15_000; return end }', '  const end = Date.now() + 1_000', ...poll)).toEqual(['poll-deadline'])
    // A block that closed before the loop is out of view, whether its bound is long or short.
    expect(rules('async function run() {', '  { const end = Date.now() + 15_000; use(end) }', '  const end = Date.now() + 1_000', ...poll)).toEqual(['poll-deadline'])
    expect(rules('async function run() {', '  { const end = Date.now() + 1_000; use(end) }', '  const end = Date.now() + 15_000', ...poll)).toEqual([])
    // The innermost block that holds the loop wins.
    expect(rules('async function run() {', '  const end = Date.now() + 15_000', '  {', '    const end = Date.now() + 1_000', '  ' + poll[0], '  }', '}')).toEqual(['poll-deadline'])
    expect(rules('async function run() {', '  const end = Date.now() + 1_000', '  {', '    const end = Date.now() + 15_000', '  ' + poll[0], '  }', '}')).toEqual([])
    // A parameter that shadows a bound of the same name hides it.
    expect(rules('const end = 800', 'async function run(end) {', '  const stop = Date.now() + end', '  while (!ready() && Date.now() < stop) await sleep(10)', '}')).toEqual([])
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

  it('counts only the sleeps every pass reaches: a sleep a pass may skip is not part of the interval', () => {
    const counted = (...body: string[]) => rules('for (let i = 0; i < 5; i++) {', ...body.map(line => `  ${line}`), '}')
    // 5 passes of 100 ms are flagged; counting the skippable 10 s sleep would make them 50 s.
    expect(counted('await sleep(100)', 'if (rare()) await sleep(10_000)')).toEqual(['poll-deadline'])
    expect(counted('await sleep(100)', 'if (rare()) { await sleep(10_000) } else { log() }')).toEqual(['poll-deadline'])
    expect(counted('await sleep(100)', 'ok() && await sleep(10_000)')).toEqual(['poll-deadline'])
    expect(counted('await sleep(100)', 'const wait = rare() ? await sleep(10_000) : 0')).toEqual(['poll-deadline'])
    expect(counted('await sleep(100)', 'try { await sleep(10_000) } catch { log() }')).toEqual(['poll-deadline'])
    expect(counted('await sleep(100)', 'for (const x of xs) await sleep(10_000)')).toEqual(['poll-deadline'])
    expect(counted('await sleep(100)', 'switch (state()) { case 1: await sleep(10_000) }')).toEqual(['poll-deadline'])
    // A `continue` before a sleep skips it; one after does not.
    expect(counted('await sleep(100)', 'if (busy()) continue', 'await sleep(10_000)')).toEqual(['poll-deadline'])
    expect(counted('if (busy()) continue', 'await sleep(10_000)')).toEqual([])
    expect(counted('await sleep(10_000)', 'if (busy()) continue')).toEqual([])
    // Sleeps every pass reaches add up, with a `break` or a `return` between them.
    expect(counted('await sleep(1_000)', 'if (ready()) break', 'await sleep(1_000)')).toEqual([])
    expect(counted('if (ready()) break', 'await sleep(10_000)')).toEqual([])
    // With only skippable sleeps there is no interval to count by.
    expect(counted('if (rare()) await sleep(10)')).toEqual([])
  })

  it('leaves a count whose limit or interval it cannot read alone: it is a bound of a size the scan cannot tell', () => {
    expect(rules('for (let i = 0; i < attempts; i++) { if (ready()) break; await sleep(50) }')).toEqual([])
    expect(rules('for (let i = 0; i < 20; i++) { if (ready()) break; await sleep(interval) }')).toEqual([])
  })

  it('leaves a loop that compares the clock with a bound it cannot read, directly or through a name', () => {
    expect(rules('while (!ready()) { if (Date.now() - t0 > limits.wait) throw new Error("late"); await sleep(10) }')).toEqual([])
    expect(rules('const t0 = Date.now()', 'while (!ready()) { const elapsed = Date.now() - t0; if (elapsed > MAX_MS) throw new Error("late"); await sleep(10) }')).toEqual([])
    expect(rules('while (!ready() && Date.now() < dueAt) await sleep(10)')).toEqual([])
  })

  it('takes a zero-delay sleep in a loop for the poll interval of a spin, and one outside a loop for a yield', () => {
    expect(rules('while (!ready()) await sleep(0)')).toEqual(['poll-deadline'])
    expect(rules('do { await new Promise(resolve => setTimeout(resolve, 0)) } while (!ready())')).toEqual(['poll-deadline'])
    expect(rules('await sleep(0)')).toEqual([])
    // A counted spin is bounded by its count, which says nothing in milliseconds.
    expect(rules('for (let i = 0; i < 50; i++) await sleep(0)')).toEqual([])
    expect(rules('const t0 = Date.now()', 'while (!ready()) { if (Date.now() - t0 > 15_000) throw new Error("late"); await sleep(0) }')).toEqual([])
  })

  it('takes a clock that is only read, or a counter that is only stepped, for no deadline', () => {
    expect(rules('while (!ready()) { log(Date.now()); await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) { stamps.push(performance.now()); await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) { attempts++; await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) { retries += 1; await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; !ready(); i++) await sleep(10)')).toEqual(['poll-deadline'])
  })

  it('counts attempts from the start and by the step, up or down, and through an && chain', () => {
    // Flagged under the 3 s floor: 2 s, 1 s, 1 s, 1 s, 2 s, 2 s and 1 s. Accepted: 12.5 s, 20 s and 12 s.
    expect(rules('for (let attempt = 100; attempt < 150; attempt += 1) await sleep(40)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 100; i += 10) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 100; i = i + 10) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 20; i > 0; i--) await sleep(50)')).toEqual(['poll-deadline'])
    expect(rules('for (let left = 20; left >= 1; left -= 1) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 20 && !ready(); i++) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('const STEP = 10', 'for (let i = 0; i < 100; i += STEP) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 100; i += 2) await sleep(250)')).toEqual([])
    expect(rules('for (let left = 200; left > 0; --left) await sleep(100)')).toEqual([])
    expect(rules('for (let i = 5; i <= 124; i++) await sleep(100)')).toEqual([])
  })

  it('leaves a counter whose step it cannot read alone', () => {
    expect(rules('for (let i = 0; i < 20; i += step) await sleep(100)')).toEqual([])
    expect(rules('for (let i = start; i < 20; i++) await sleep(100)')).toEqual([])
  })

  it('does not take a bound from a function nested in the loop: it is the helper\'s, not the loop\'s', () => {
    expect(rules('while (!ready()) {', '  const unused = (since: number) => Date.now() - since > 15_000', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) {', '  const late = () => { for (let attempt = 0; attempt < 500; attempt += 1) { void attempt } }', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) {', '  const bump = () => { retries += 1; return retries > 5 }', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) {', '  const unused = () => Date.now()', '  if (Date.now() - t0 > 15_000) throw new Error("late")', '  await sleep(10)', '}')).toEqual([])
  })

  it('gives a loop the earliest of its exits: a comparison that ends nothing bounds nothing', () => {
    // Only the `throw` leaves the loop; `rotate()` leaves nothing, so the 1 s comparison is not a deadline.
    expect(rules('while (!ready()) {', '  if (Date.now() - a > 60_000) throw new Error("late")', '  if (Date.now() - b > 1_000) rotate()', '  await sleep(10)', '}')).toEqual([])
    expect(rules('while (!ready()) {', '  if (Date.now() - a > 2_000) throw new Error("late")', '  if (Date.now() - b > 1_000) rotate()', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    // Two exits: the loop ends at the first to fire, whichever is written first.
    expect(rules('while (!ready()) {', '  if (Date.now() - a > 60_000) throw new Error("late")', '  if (Date.now() - b > 1_000) break', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) {', '  if (Date.now() - b > 1_000) break', '  if (Date.now() - a > 60_000) throw new Error("late")', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) {', '  if (Date.now() - b > 20_000) break', '  if (Date.now() - a > 60_000) throw new Error("late")', '  await sleep(10)', '}')).toEqual([])
    // An `else` that leaves ends the loop when the test is false.
    expect(rules('while (!ready()) {', '  if (Date.now() - a < 1_000) await sleep(10); else throw new Error("late")', '}')).toEqual(['poll-deadline'])
    // A `break` in a loop of its own leaves that loop, not this one.
    expect(rules('while (!ready()) {', '  for (const item of items) { if (Date.now() - b > 1_000) break }', '  if (Date.now() - a > 60_000) throw new Error("late")', '  await sleep(10)', '}')).toEqual([])
  })

  it('bounds an && chain by its smallest part and an || chain by its largest', () => {
    const wait = (condition: string) => rules(`const start = Date.now()`, `while (${condition}) await sleep(10)`)
    expect(wait('!ready() && Date.now() < start + 1_000 && Date.now() < start + 15_000')).toEqual(['poll-deadline'])
    expect(wait('Date.now() < start + 15_000 && !ready() && Date.now() < start + 1_000')).toEqual(['poll-deadline'])
    expect(wait('!ready() && Date.now() < start + 15_000 && Date.now() < start + 20_000')).toEqual([])
    expect(wait('Date.now() < start + 1_000 || Date.now() < start + 15_000')).toEqual([])
    expect(wait('Date.now() < start + 1_000 || Date.now() < start + 2_000')).toEqual(['poll-deadline'])
    // Parentheses group as the language does.
    expect(wait('(Date.now() < start + 1_000 || Date.now() < start + 15_000) && !ready()')).toEqual([])
    expect(wait('(Date.now() < start + 1_000 && !ready()) || Date.now() < start + 2_000')).toEqual(['poll-deadline'])
    // A part that bounds nothing, beside one that does, leaves an || chain with no bound: the loop may never end by the part that has one.
    // An operator the scan does not read leaves none either.
    expect(wait('!ready() || Date.now() < start + 1_000')).toEqual(['poll-deadline'])
    expect(wait('!ready() || Date.now() < start + 15_000')).toEqual(['poll-deadline'])
    expect(wait('(ready() ? Date.now() < start + 15_000 : false)')).toEqual(['poll-deadline'])
    expect(wait('(Date.now() < start + 15_000) ?? ready()')).toEqual(['poll-deadline'])
  })

  it('takes the smallest attempt count of an && chain, whichever conjunct comes first', () => {
    expect(rules('for (let i = 0; i < 500 && i < 5; i++) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 5 && i < 500; i++) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 500 && i < 50; i++) await sleep(100)')).toEqual([])
    // The attempts and the clock bound the loop together; it ends at the first.
    expect(rules('for (let i = 0; i < 3; i++) { if (Date.now() - t0 > 15_000) throw new Error("late"); await sleep(100) }')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 300; i++) { if (Date.now() - t0 > 1_000) throw new Error("late"); await sleep(100) }')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 300; i++) { if (Date.now() - t0 > 15_000) throw new Error("late"); await sleep(100) }')).toEqual([])
  })

  it('takes a counter the body writes for no bound: the header\'s count says nothing about how long the loop runs', () => {
    // The body rewinds the counter, so the header's count is a floor on the run, not its length.
    for (const write of ['if (retry()) i = 0', 'if (retry()) i -= 1', 'if (retry()) i--', 'if (retry()) [i] = [0]', 'if (retry()) ({ i } = origin)', 'i = 0']) {
      expect(rules(`for (let i = 0; i < 10; i++) { ${write}; await sleep(1_000) }`)).toEqual(['poll-deadline'])
    }
    expect(rules('for (let i = 0; i < 10; i++) { const rewind = () => { i = 0 }; if (retry()) rewind(); await sleep(1_000) }')).toEqual(['poll-deadline'])
    // A name the body only reads is still a counter.
    expect(rules('for (let i = 0; i < 10; i++) { log(i); await sleep(100) }')).toEqual(['poll-deadline'])
    // A body that declares its own `i` leaves the header\'s counter alone.
    expect(rules('for (let i = 0; i < 100; i++) { { let i = 5; use(i) } await sleep(200) }')).toEqual([])
  })

  it('resolves a name at the place it is read: a block the use cannot see does not declare it', () => {
    // The head reads the outer `end`; the loop body\'s inner block declares another one.
    expect(rules('const end = Date.now() + 1_000', 'while (Date.now() < end) {', '  { const end = Date.now() + 15_000; use(end) }', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('const end = Date.now() + 15_000', 'while (Date.now() < end) {', '  { const end = Date.now() + 1_000; use(end) }', '  await sleep(10)', '}')).toEqual([])
    // The same for an exit in the body.
    expect(rules('const end = Date.now() + 1_000', 'while (!ready()) {', '  { const end = Date.now() + 15_000; use(end) }', '  if (Date.now() > end) throw new Error("late")', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    // A declaration the use is inside of wins.
    expect(rules('const end = Date.now() + 15_000', 'while (!ready()) {', '  const end = Date.now() + 1_000', '  if (Date.now() > end) throw new Error("late")', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    // A later declaration is not in view yet.
    expect(rules('const end = Date.now() + 15_000', 'while (!ready()) {', '  if (Date.now() > end) throw new Error("late")', '  { const end = Date.now() + 1_000; use(end) }', '  await sleep(10)', '}')).toEqual([])
  })

  it('takes the smallest value a reassigned name can hold, and none when it cannot tell', () => {
    expect(rules('let end = Date.now() + 15_000', 'end = Date.now() + 1_000', 'while (Date.now() < end) await sleep(10)')).toEqual(['poll-deadline'])
    expect(rules('let end = Date.now() + 1_000', 'end = Date.now() + 15_000', 'while (Date.now() < end) await sleep(10)')).toEqual(['poll-deadline'])
    expect(rules('let end = Date.now() + 15_000', 'end = Date.now() + 20_000', 'while (Date.now() < end) await sleep(10)')).toEqual([])
    // A write that is not a plain assignment leaves the value unknown; one in the loop, or in a closure, moves the deadline, so it bounds nothing.
    expect(rules('let end = Date.now() + 1_000', 'while (Date.now() < end) { end += 20_000; await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('let end = Date.now() + 1_000', 'const extend = () => { end++ }', 'while (Date.now() < end) { extend(); await sleep(10) }')).toEqual(['poll-deadline'])
    // A constant of the file that is assigned again is no constant.
    expect(rules('let LIMIT = 800', 'LIMIT = 20_000', 'async function run() {', '  const end = Date.now() + LIMIT', '  while (Date.now() < end) await sleep(10)', '}')).toEqual([])
    expect(rules('const LIMIT = 800', 'async function run() {', '  const end = Date.now() + LIMIT', '  while (Date.now() < end) await sleep(10)', '}')).toEqual(['poll-deadline'])
    // In the loop\'s own scope the plain assignments are values it can hold, and the smallest counts.
    expect(rules('let LIMIT = 800', 'LIMIT = 20_000', 'const end = Date.now() + LIMIT', 'while (Date.now() < end) await sleep(10)')).toEqual(['poll-deadline'])
    // A flag that holds a deadline comparison carries its bound.
    expect(rules('while (!ready()) {', '  const late = Date.now() - t0 > 1_000', '  if (late) break', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) {', '  const late = Date.now() - t0 > 15_000', '  if (late) break', '  await sleep(10)', '}')).toEqual([])
  })

  it('counts an exit only when it is a statement of the loop body that leaves on its own', () => {
    const late = 'Date.now() - t0 > 15_000'
    const exits = (...body: string[]) => rules('async function run() {', '  while (!ready()) {', ...body.map(line => `    ${line}`), '    await sleep(10)', '  }', '}')
    // Written as a statement of the body: a bare leave, or a block with the leave among its own statements.
    expect(exits(`if (${late}) break`)).toEqual([])
    expect(exits(`if (${late}) return`)).toEqual([])
    expect(exits(`if (${late}) { log(); throw new Error("late") }`)).toEqual([])
    expect(exits(`if (${late}) { break }`)).toEqual([])
    expect(rules('do {', `  if (${late}) break`, '  await sleep(10)', '} while (!ready())')).toEqual([])
    // Inside another `if`, an `else`, an `else if`, a `switch`, a `try`, a block or a loop it may never be reached.
    expect(exits('if (rare()) {', `  if (${late}) break`, '}')).toEqual(['poll-deadline'])
    expect(exits('if (rare()) log(); else {', `  if (${late}) break`, '}')).toEqual(['poll-deadline'])
    expect(exits('if (rare()) log(); else', `  if (${late}) break`)).toEqual(['poll-deadline'])
    expect(exits(`if (rare()) log(); else if (${late}) break`)).toEqual(['poll-deadline'])
    expect(exits('switch (kind) { case 1:', `  if (${late}) return`, '}')).toEqual(['poll-deadline'])
    expect(exits('try {', `  if (${late}) throw new Error("late")`, '} catch { log() }')).toEqual(['poll-deadline'])
    expect(exits('{', `  if (${late}) break`, '}')).toEqual(['poll-deadline'])
    expect(exits('for (const item of items) {', `  if (${late}) return`, '}')).toEqual(['poll-deadline'])
    expect(exits('while (more()) {', `  if (${late}) return`, '}')).toEqual(['poll-deadline'])
    // A branch that leaves only inside another `if` may never leave, and an `else` that leaves is not an exit on the test.
    expect(exits(`if (${late}) {`, '  if (strict) throw new Error("late")', '}')).toEqual(['poll-deadline'])
    expect(exits(`if (${late}) { log() } else break`)).toEqual(['poll-deadline'])
    expect(exits(`if (!(${late})) { log() } else break`)).toEqual(['poll-deadline'])
    // Before a statement that can skip the rest of the pass.
    expect(exits(`if (${late}) break`, 'if (skip()) continue')).toEqual([])
    expect(exits('if (skip()) continue', `if (${late}) break`)).toEqual(['poll-deadline'])
    expect(exits('for (const item of items) { if (skip(item)) continue }', `if (${late}) break`)).toEqual(['poll-deadline'])
    // The loop head still counts beside such exits, and a reason accepts a loop whose exit is one the scan does not read.
    expect(rules('const t0 = Date.now()', 'while (!ready() && Date.now() - t0 < 15_000) {', '  if (rare()) { if (Date.now() - t0 > 1_000) break }', '  await sleep(10)', '}')).toEqual([])
    expect(rules('// bound: ends when `rare` turns true, which the fixture below controls', 'while (!ready()) {', '  if (rare()) { if (Date.now() - t0 > 15_000) break }', '  await sleep(10)', '}')).toEqual([])
  })

  it('reads a clock comparison only with <, <=, > or >=: an equality can miss the value and never fire', () => {
    for (const operator of ['!==', '===', '!=', '==']) {
      expect(rules('const end = Date.now() + 15_000', `while (Date.now() ${operator} end) await sleep(10)`)).toEqual(['poll-deadline'])
      expect(rules('const t0 = Date.now()', `while (Date.now() - t0 ${operator} 15_000) await sleep(10)`)).toEqual(['poll-deadline'])
      expect(rules('const t0 = Date.now()', `while (!ready()) { if (Date.now() - t0 ${operator} 15_000) throw new Error("late"); await sleep(10) }`)).toEqual(['poll-deadline'])
      expect(rules('const t0 = Date.now()', `while (!ready()) { if (15_000 ${operator} Date.now() - t0) throw new Error("late"); await sleep(10) }`)).toEqual(['poll-deadline'])
      expect(rules(`for (let i = 0; i ${operator} 150; i += 1) await sleep(100)`)).toEqual(['poll-deadline'])
    }
    for (const operator of ['<', '<=', '>', '>=']) {
      expect(rules('const t0 = Date.now()', `while (!ready()) { if (Date.now() - t0 ${operator} 15_000) throw new Error("late"); await sleep(10) }`)).toEqual([])
    }
  })

  it('reads a start or a deadline the loop sets again as no bound: it moves away as time passes', () => {
    expect(rules('let start = Date.now()', 'while (Date.now() - start < 15_000) { start = Date.now(); await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('let end = Date.now() + 15_000', 'while (Date.now() < end) { end = Date.now() + 15_000; await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('let start = Date.now()', 'while (!ready()) { if (Date.now() - start > 15_000) throw new Error("late"); start = Date.now(); await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('const state = { t0: Date.now() }', 'while (Date.now() - state.t0 < 15_000) { state.t0 = Date.now(); await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('let start = Date.now()', 'const restart = () => { start = Date.now() }', 'while (Date.now() - start < 15_000) { restart(); await sleep(10) }')).toEqual(['poll-deadline'])
    // Declared in the body, they are new on every pass; declared in a `for` header, they are set once.
    expect(rules('while (!ready()) {', '  const start = Date.now()', '  if (Date.now() - start > 15_000) throw new Error("late")', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) {', '  const end = Date.now() + 15_000', '  if (Date.now() > end) throw new Error("late")', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('for (const end = Date.now() + 15_000; Date.now() < end;) await sleep(10)')).toEqual([])
    // A name set from the clock in the body is a fresh read of it; it is bounded by a start the loop leaves alone.
    expect(rules('const t0 = Date.now()', 'while (!ready()) {', '  const elapsed = Date.now() - t0', '  if (elapsed > 15_000) throw new Error("late")', '  await sleep(10)', '}')).toEqual([])
    expect(rules('const deadline = Date.now() + 15_000', 'while (!ready()) {', '  const now = Date.now()', '  if (now > deadline) throw new Error("late")', '  await sleep(10)', '}')).toEqual([])
    expect(rules('let t0 = Date.now()', 'while (!ready()) {', '  t0 = Date.now()', '  const elapsed = Date.now() - t0', '  if (elapsed > 15_000) throw new Error("late")', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) {', '  const now = Date.now()', '  if (now > 15_000) throw new Error("late")', '  await sleep(10)', '}')).toEqual(['poll-deadline'])
  })

  it('reads a clock comparison only in the forms it lists', () => {
    expect(rules('while (Math.floor(Date.now() / 1000) <= second) await sleep(10)')).toEqual(['poll-deadline'])
    expect(rules('while (Date.now() * 2 < limit) await sleep(10)')).toEqual(['poll-deadline'])
    expect(rules('while (!ready()) { if (Math.floor(Date.now() / 1000) > second) break; await sleep(10) }')).toEqual(['poll-deadline'])
    expect(rules('const t0 = Date.now()', 'while (Date.now() - t0 - slack < 15_000) await sleep(10)')).toEqual(['poll-deadline'])
    // The listed forms, in both orientations.
    expect(rules('const t0 = Date.now()', 'while (Date.now() - t0 < 15_000) await sleep(10)')).toEqual([])
    expect(rules('const t0 = Date.now()', 'while (15_000 > Date.now() - t0) await sleep(10)')).toEqual([])
    expect(rules('const t0 = Date.now()', 'while (Date.now() < t0 + 15_000) await sleep(10)')).toEqual([])
    expect(rules('const t0 = Date.now()', 'while (t0 + 15_000 > Date.now()) await sleep(10)')).toEqual([])
    expect(rules('const deadline = Date.now() + 15_000', 'while (Date.now() < deadline) await sleep(10)')).toEqual([])
  })

  it('counts only the counter of a for header: a step in the body may never run', () => {
    expect(rules('let tries = 0', 'while (!ready()) { if (tries++ > 20) throw new Error("late"); await sleep(100) }')).toEqual(['poll-deadline'])
    expect(rules('let n = 0', 'while (n < 20) { if (rare()) n += 1; await sleep(100) }')).toEqual(['poll-deadline'])
    expect(rules('let n = 0', 'while (n < 20) { n += 1; await sleep(100) }')).toEqual(['poll-deadline'])
    expect(rules('while (!ready() && retries < 5) { retries += 1; await sleep(100) }')).toEqual(['poll-deadline'])
    expect(rules('while (retries-- > 0) await sleep(100)')).toEqual(['poll-deadline'])
    // A for header whose update never gets the counter to its limit runs for ever.
    expect(rules('for (let i = 0; i < 20; i -= 1) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 20; i > 0; i += 1) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 20; i += 0) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 20; j++) await sleep(100)')).toEqual(['poll-deadline'])
    expect(rules('for (let i = 0; i < 20;) await sleep(100)')).toEqual(['poll-deadline'])
    // A count that ends the loop only beside a part with no bound is no bound.
    expect(rules('for (let i = 0; i < 20 || !done(); i++) await sleep(100)')).toEqual(['poll-deadline'])
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
