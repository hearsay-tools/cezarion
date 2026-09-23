import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * The agent-browser provider seam. Every e2e spec drives the app through this module and
 * never through a browser library directly, because `.ai/agentic.config.json` names the
 * provider (`browser.provider`) and `.ai/browsers/agent-browser.md` defines the operations.
 * Swapping providers must mean rewriting this file only.
 *
 * Each exported function maps to one operation in that descriptor: open, snapshot, eval/get
 * (assert), screenshot, close.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')
const descriptorPath = resolve(repoRoot, '.ai/qa/test-env.json')

/**
 * The built CLI a spec spawns when it needs its OWN cezar rather than the shared test env
 * (a pinned `runs.json` fixture, an empty repo, a second project).
 *
 * Exported from here rather than re-derived per spec because it is one fact about the build
 * layout, and it has already moved once: `npm run build` emits the server into the workspace
 * package (`packages/cezar/dist`), not into a root-level `dist/`.
 */
export const cezarCli = resolve(repoRoot, 'packages/cezar/dist/index.js')

/**
 * Failure bundles (#408). A red cockpit shard used to leave nothing behind but
 * `Wait timed out after 25000ms`, so #369 and #393 closed on guesses. Now the seam — the only
 * module that knows the browser session — writes what the page looked like at the moment a
 * wait gave up, under `.ai/qa/failures/<spec>/<test>-<n>/`:
 *
 *   screenshot.png   the viewport (never full-page: stitching scrolls the document and would
 *                    move the very state being captured)
 *   snapshot.txt     `snapshot -i`, the accessibility tree
 *   probe.json       the URL, the selector or predicate that timed out, and a page probe —
 *                    the focused element's path, the target's count, rect, computed style and
 *                    the element under its centre
 *
 * The spec and test names come from `failure-setup.ts`, which registers them per test from
 * vitest's context; the seam itself imports nothing from vitest so a unit test can drive it
 * through a stand-in binary. The root is overridable for the same reason.
 */
const defaultFailureRoot = resolve(repoRoot, '.ai/qa/failures')
const failureCapture: { root: string; spec: string; test: string } = {
  root: defaultFailureRoot,
  spec: 'unknown-spec',
  test: 'unknown-test',
}

export function configureFailureCapture(next: { root?: string; spec?: string; test?: string }): void {
  if ('root' in next) failureCapture.root = next.root ?? defaultFailureRoot
  if ('spec' in next) failureCapture.spec = next.spec ?? 'unknown-spec'
  if ('test' in next) failureCapture.test = next.test ?? 'unknown-test'
}

/** A filesystem-safe segment: vitest test names carry spaces, quotes and slashes. */
function bundleSegment(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return (safe || 'unnamed').slice(0, 80)
}

/** The next free `<spec>/<test>-<n>` under the root — free on disk, not in memory, so bundles
 *  from an earlier local run are never overwritten. */
function nextBundleDir(): string {
  const specDir = join(failureCapture.root, bundleSegment(failureCapture.spec))
  const test = bundleSegment(failureCapture.test)
  for (let n = 1; ; n += 1) {
    const dir = join(specDir, `${test}-${n}`)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      return dir
    }
  }
}

/** Every seam attached and not yet closed, oldest first. */
const attached: AgentBrowser[] = []

/** The seam most recently attached and not yet closed — how `failure-setup.ts`'s
 *  `onTestFailed` hook reaches the browser a spec holds in its own module scope.
 *
 *  A stack, not a single slot: `github.e2e.ts` keeps its main browser open and attaches a
 *  short-lived one per state, and its `finally` closes that one before `onTestFailed` runs.
 *  Closing it must hand the hook back to the main browser, not to nothing. */
export function lastAttachedBrowser(): AgentBrowser | null {
  return attached.at(-1) ?? null
}

type FailureReason =
  | { kind: 'wait-selector'; action: 'click' | 'hover' | 'fill'; selector: string }
  | { kind: 'wait-fn'; predicate: string }
  | { kind: 'wait-value'; expression: string; lastValue: unknown; lastError?: string }
  | { kind: 'test' }

/**
 * The CLI's own default wait budget, read from the variable agent-browser reads
 * (`AGENT_BROWSER_DEFAULT_TIMEOUT`, milliseconds), so a seam-side poll gives up when a
 * `wait <selector>` would. 25 s stays inside both `run()`'s 60 s kill and the suite's 60 s test
 * timeout; a unit test shortens it through the same variable.
 */
function defaultWaitTimeoutMs(): number {
  const fromEnv = Number(process.env.AGENT_BROWSER_DEFAULT_TIMEOUT)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 25_000
}

/** A blocking pause. The seam is synchronous end to end (`execFileSync`), so a poll interval
 *  cannot `await`; `Atomics.wait` sleeps the thread without spinning it. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** `JSON.stringify` bounded for an error message: a sample can be a whole layout snapshot. */
function summarize(value: unknown, max = 400): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * What `waitForValue` throws when the matcher never passed. Carries the last sample so a helper
 * built on the primitive (`focusWithKeyboard`) can name what it saw — the element that took
 * focus — without a second, one-shot read of a page that has already moved on.
 */
export class WaitForValueError extends Error {
  constructor(
    message: string,
    readonly expression: string,
    readonly lastValue: unknown,
    readonly bundle: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WaitForValueError'
  }
}

/**
 * The in-page probe. Built as one expression so a single `eval` fetches everything, and
 * every branch is wrapped so a selector the CSS engine rejects (agent-browser also accepts
 * `text=` and `@ref`) records the rejection instead of failing the probe.
 *
 * A timed-out predicate is recorded in `probe.json`, never re-run here: specs put side effects
 * in predicates (`thread-scroll.e2e.ts` clicks a button inside one), and a capture that fired
 * them again would alter the session the spec's remaining tests share. The probe only reads.
 */
function probeScript(reason: FailureReason): string {
  const selector = reason.kind === 'wait-selector' ? JSON.stringify(reason.selector) : 'null'
  return `(() => {
    const path = (el) => {
      const parts = []
      for (let node = el; node && node.nodeType === 1 && parts.length < 12; node = node.parentElement) {
        let part = node.tagName.toLowerCase()
        if (node.id) part += '#' + node.id
        else {
          const cls = [...node.classList].slice(0, 3).join('.')
          if (cls) part += '.' + cls
          const parent = node.parentElement
          if (parent) {
            const siblings = [...parent.children].filter((c) => c.tagName === node.tagName)
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
          }
        }
        parts.unshift(part)
      }
      return parts.join(' > ')
    }
    const describe = (el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const under = document.elementFromPoint(cx, cy)
      return {
        path: path(el),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
        style: {
          display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
          pointerEvents: cs.pointerEvents, position: cs.position, zIndex: cs.zIndex,
          transform: cs.transform, transition: cs.transition,
        },
        attributes: Object.fromEntries([...el.attributes].slice(0, 12).map((a) => [a.name, a.value.slice(0, 120)])),
        text: (el.textContent || '').trim().slice(0, 120),
        elementUnderCentre: under
          ? { path: path(under), coversTarget: under !== el && !el.contains(under) }
          : null,
      }
    }
    const out = {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      activeElement: document.activeElement && document.activeElement !== document.body
        ? describe(document.activeElement)
        : null,
      openDialogs: [...document.querySelectorAll('[role="dialog"], dialog[open]')].map(path),
    }
    const selector = ${selector}
    if (selector !== null) {
      try {
        const nodes = [...document.querySelectorAll(selector)]
        out.target = { count: nodes.length, matches: nodes.slice(0, 5).map(describe) }
      } catch (error) {
        out.target = { count: null, selectorError: String(error) }
      }
    }
    return out
  })()`
}

type EnvDescriptor = {
  baseUrl: string
  browser: {
    installed: boolean
    command: string
    version: string
    notes: string
    launchArgs?: string[]
    runtimeEnv?: Record<string, string>
    namespace?: string
  }
}

export function browserSpawnPlan(
  browser: EnvDescriptor['browser'],
  session: string,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
): { argv: string[]; env: NodeJS.ProcessEnv } {
  const argv: string[] = []
  if (browser.namespace) argv.push('--namespace', browser.namespace)
  const extra = (env.AGENT_BROWSER_ARGS ?? '')
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
  const launchArgs = [...(browser.launchArgs ?? [])]
  for (const arg of extra) if (!launchArgs.includes(arg)) launchArgs.push(arg)
  if (launchArgs.length) argv.push('--args', launchArgs.join(','))
  argv.push('--session', session, ...command)
  if (!command.includes('--json')) argv.push('--json')
  return { argv, env: { ...env, ...browser.runtimeEnv } }
}

/** The shared descriptor written by .ai/scripts/test-env-up.sh — QA and e2e attach to the
 *  exact same instance rather than each booting their own. */
export function readTestEnv(): EnvDescriptor {
  try {
    return JSON.parse(readFileSync(descriptorPath, 'utf8')) as EnvDescriptor
  } catch (cause) {
    throw new Error(
      `cezar e2e: cannot read ${descriptorPath}. Run \`npm run test:e2e\`, which boots the env first.`,
      { cause },
    )
  }
}

/**
 * The environment for a spec-owned `cezar serve` over a throwaway `dataRoot`.
 *
 * `CEZ_DRY_RUN` is why these boots need no network and no agent login. `CEZ_HOME` is why they
 * are *isolated*: since the multi-project workspace landed, booting in an unregistered folder
 * APPENDS it to `~/.cezar/config.json`, so an unpinned fixture server would (a) litter the
 * developer's real registry with a dead `/tmp/cezar-e2e-…` entry per run and (b) make every
 * spec order-dependent — once the registry holds more than one project the sidebar renders
 * the grouped multi-project shell instead of the flat one these specs assert against.
 * Pinning it inside `dataRoot` means the spec's own `rmSync(dataRoot)` cleans it up too.
 * `CEZ_REMOTE` defaults to local (`0`) for the same reason — a hosted parent would otherwise
 * hide account catalogs under `localHandoff:false` (#358); pass `CEZ_REMOTE: '1'` in `extra`
 * when a fixture intentionally tests hosted security.
 *
 * The shared test env pins the same variable under `.ai/qa/cez-home`
 * (`.ai/scripts/test-env-up.sh`); this is that rule for the specs that boot their own server.
 */
export function fixtureServeEnv(
  dataRoot: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const fixtureRoot = realpathSync(dataRoot)
  // Git has multiple redirection mechanisms (including numbered config entries).
  // None belongs to a disposable fixture. Use this exact environment for discovery
  // and the child; otherwise a safe preflight can precede an unsafe CLI boot.
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key]
  // Cezar pins TMPDIR inside the ambient checkout. Without a ceiling, discovery
  // climbs into that checkout and a non-Git fixture looks nested and unsafe.
  // Bound both discovery and the child at tmpdir so nested repos inside temp
  // still fail the safety check, while the host worktree cannot be inherited.
  env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir())
  const discovery = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: fixtureRoot, env: { ...env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 5_000,
  })
  if (discovery.status === 0 && !discovery.error) {
    if (realpathSync(discovery.stdout.trim()) !== fixtureRoot) {
      throw new Error(`cezar e2e: Git resolves outside fixture ${fixtureRoot}; refusing server boot`)
    }
  } else if (discovery.error || discovery.status !== 128 ||
    !discovery.stderr.startsWith('fatal: not a git repository (or any of the parent directories): .git')) {
    throw new Error(`cezar e2e: cannot verify fixture repository ${fixtureRoot}; refusing server boot`, { cause: discovery.error })
  }
  return {
    ...env,
    // One line on purpose: the `fixture-serve-must-pin-cez-home` design guardian reads these
    // two together, and a CEZ_DRY_RUN without CEZ_HOME beside it is exactly the mistake it
    // exists to catch.
    CEZ_DRY_RUN: '1', CEZ_HOME: resolve(fixtureRoot, '.cez-home'),
    // A fixture repo must hold exactly the skills the fixture wrote. Open Mercato skill updates
    // are default-on (AGENTS.md § Zero config), so a boot inside the six-hour window installs the
    // whole `om-*` collection INTO the fixture and every "these are the project skills"
    // assertion starts depending on the machine's cache and network. The shared test env
    // (`skills-update.e2e.ts` attaches to it) is where that behaviour is exercised on purpose;
    // `extra` can still turn it back on for a spec that wants it.
    CEZ_SKILLS_AUTO_UPDATE: extra.CEZ_SKILLS_AUTO_UPDATE ?? '0',
    // Local by default (#358). A hosted parent exports CEZ_REMOTE=1 into process.env; spreading
    // it would hide the account catalog and trip phone-layout assertions. Specs that exercise
    // hosted security pass CEZ_REMOTE: '1' in extra.
    CEZ_REMOTE: extra.CEZ_REMOTE ?? '0',
  }
}

/**
 * A JSON GET that survives a RESET idle connection.
 *
 * Specs boot a server, drive the browser for tens of seconds, then read the API back. Node's
 * fetch pools the connection opened during the health probe, and reusing a socket the server has
 * since closed surfaces as `ECONNRESET` — a dead connection, never a dead server (the process is
 * still answering the browser at that moment). One retry opens a fresh one.
 */
export async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await (await fetch(url)).json()) as T
    } catch (error) {
      if (attempt >= 2) throw error
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

/**
 * The id of the project a server booted in — the `/p/<projectId>` prefix every cockpit URL
 * carries since the multi-project spec's step 3.2.
 *
 * Specs resolve it from the live server rather than deriving it from the fixture's folder name:
 * the slug is allocated by the registry (lowercased, deduplicated), so only the server knows it.
 */
export async function bootProjectId(baseUrl: string): Promise<string> {
  const { bootProject } = (await (await fetch(`${baseUrl}/api/v1/projects`)).json()) as {
    bootProject: string
  }
  if (!bootProject) throw new Error(`cezar e2e: ${baseUrl}/api/v1/projects named no boot project`)
  return bootProject
}

export class AgentBrowser {
  // A unique session per run, per the descriptor's rules — never attach to a user's profile.
  private constructor(
    private readonly bin: string,
    private readonly session: string,
    private readonly browser: EnvDescriptor['browser'],
  ) {}

  static open(session: string): AgentBrowser {
    return AgentBrowser.attach(readTestEnv().browser, session)
  }

  /** The same seam over an explicit provider descriptor rather than the shared test env's —
   *  how a unit test drives it through a stand-in binary without a Chrome behind it. */
  static attach(browser: EnvDescriptor['browser'], session: string): AgentBrowser {
    if (!browser.installed) {
      throw new Error(`cezar e2e: the agent-browser provider is not installed (${browser.notes})`)
    }
    const seam = new AgentBrowser(browser.command, session, browser)
    attached.push(seam)
    return seam
  }

  /** The `<spec>/<test>` a bundle was last written for — how a wait failure and the
   *  `onTestFailed` hook that follows it agree on writing one bundle, not two. */
  private capturedFor: string | null = null

  /**
   * Write a failure bundle and return its directory. Never throws: a capture step that failed
   * is recorded inside the bundle (`probe.json` → `captureErrors`), and a bundle that could not
   * be created at all comes back as a `<none: …>` marker, because the wait that triggered it is
   * the failure worth reporting and a second error would mask it.
   */
  private captureFailure(reason: FailureReason, error: unknown): string {
    let dir: string
    try {
      dir = nextBundleDir()
    } catch (cause) {
      // No directory, no bundle — but the wait that brought us here is still the failure to
      // report, so hand back a marker the error message can carry instead of throwing.
      return `<none: ${describeError(cause)}>`
    }
    const captureErrors: string[] = []
    const attempt = (step: string, fn: () => void) => {
      try {
        fn()
      } catch (cause) {
        captureErrors.push(`${step}: ${describeError(cause)}`)
      }
    }
    let page: unknown = null
    attempt('screenshot', () => this.screenshot(join(dir, 'screenshot.png'), { viewport: true }))
    attempt('snapshot', () => writeFileSync(join(dir, 'snapshot.txt'), this.snapshot()))
    attempt('probe', () => { page = this.evaluate(probeScript(reason)) })
    const probe = {
      ...reason,
      spec: failureCapture.spec,
      test: failureCapture.test,
      session: this.session,
      capturedAt: new Date().toISOString(),
      error: describeError(error),
      page,
      ...(captureErrors.length ? { captureErrors } : {}),
    }
    attempt('probe.json', () => writeFileSync(join(dir, 'probe.json'), JSON.stringify(probe, null, 2)))
    this.capturedFor = `${failureCapture.spec}/${failureCapture.test}`
    return dir
  }

  /**
   * The bundle for a test that failed on something other than a wait — a plain `expect`.
   * Called by `failure-setup.ts`'s `onTestFailed` hook. Returns `null` when this test already
   * has a bundle from a wait that timed out inside it, since that bundle is the page at the
   * moment of failure and a second one taken after the test unwound would only add noise.
   */
  captureTestFailure(errors: readonly unknown[]): string | null {
    if (this.capturedFor === `${failureCapture.spec}/${failureCapture.test}`) return null
    return this.captureFailure({ kind: 'test' }, errors.length === 1 ? errors[0] : errors)
  }

  /** One agent-browser invocation. `--json` on every call so results are parsed, not scraped. */
  private run(args: string[]): Record<string, unknown> {
    const plan = browserSpawnPlan(this.browser, this.session, args)
    let stdout: string
    try {
      stdout = execFileSync(this.bin, plan.argv, {
        encoding: 'utf8',
        // A hung browser must fail the spec, not the whole suite's wall clock.
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: plan.env,
      })
    } catch (cause) {
      throw new Error(`cezar e2e: agent-browser ${args.join(' ')} failed`, { cause })
    }
    const parsed = JSON.parse(stdout) as { success: boolean; data?: unknown; error?: unknown }
    if (!parsed.success) {
      throw new Error(`cezar e2e: agent-browser ${args.join(' ')} → ${JSON.stringify(parsed.error)}`)
    }
    return (parsed.data ?? {}) as Record<string, unknown>
  }

  /** operation: open */
  goto(url: string): void {
    this.run(['open', url])
  }

  /** operation: snapshot — the accessibility tree, as the string the descriptor documents. */
  snapshot(): string {
    return String(this.run(['snapshot', '-i']).snapshot ?? '')
  }

  /** operation: assert (`get text`) */
  text(selector: string): string {
    return String(this.run(['get', 'text', selector]).text ?? '')
  }

  /** operation: assert (`get url`) */
  url(): string {
    return String(this.run(['get', 'url']).url ?? '')
  }

  /** operation: assert (`is visible`).
   *
   *  Throws when nothing matches — the CLI reports an absent element as a failed query, not as
   *  "not visible". Use `count` for anything that unmounts rather than hides. */
  isVisible(selector: string): boolean {
    return this.run(['is', 'visible', selector]).visible === true
  }

  /** operation: assert (`eval`) — how many nodes match.
   *
   *  The distinction from `isVisible` is real and load-bearing: the desktop sidebar is in the DOM
   *  but display:none, while a closed Radix dialog is not in the DOM at all. Only this can say
   *  which of the two a surface is, and only this can assert absence without erroring. */
  count(selector: string): number {
    return Number(this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`))
  }

  /** operation: interact (`wait --fn`) — block until a predicate is truthy in the page.
   *
   *  Animated surfaces need this. The drawer slides in over 500ms, so for half a second after the
   *  tap that opened it, it is mounted, "visible", and still entirely off-screen — sampling it in
   *  that window answers every question wrong. */
  waitForFunction(js: string): void {
    try {
      this.run(['wait', '--fn', js])
    } catch (cause) {
      const bundle = this.captureFailure({ kind: 'wait-fn', predicate: js }, cause)
      throw new Error(`cezar e2e: predicate never became truthy: ${js} (failure bundle: ${bundle})`, { cause })
    }
  }

  /** operation: assert (`eval`), polled — "wait, then read" as one step (#409).
   *
   *  `waitForFunction` answers *whether* the page reached a state; the read that follows it is a
   *  second CLI call against a page that may have moved on, which is the two-call race
   *  `hoverVisiblePoint` used to lose (`no visible hover point`: the predicate scrolled and
   *  hit-tested, the read hit-tested a layout that had shifted since). This samples `js` until
   *  `matcher` accepts a value and returns THAT value, so the state checked and the state read
   *  are the same sample.
   *
   *  The default matcher accepts anything but `null`, `undefined` and `false`, so an expression
   *  can answer "not yet" with `null` and still hand back `0` or `''` as a real value. A sample
   *  whose expression throws in the page (`querySelector(...)` was `null`) is a miss, not a
   *  failure: it is retried, and the last page error is reported if nothing ever matched.
   *
   *  Gives up after the CLI's default timeout (`AGENT_BROWSER_DEFAULT_TIMEOUT`, 25 s) through
   *  the #408 failure bundle, whose `probe.json` records the expression and the last sample.
   *  `failure` replaces the generic headline of that error with the caller's own ("no visible
   *  hover point for …"). Never use it to assert absence: "not there" is a value, read it once. */
  waitForValue<T, U extends T>(
    js: string,
    matcher: (value: T) => value is U,
    options?: { intervalMs?: number; failure?: string },
  ): U
  waitForValue<T = unknown>(
    js: string,
    matcher?: (value: T) => boolean,
    options?: { intervalMs?: number; failure?: string },
  ): T
  waitForValue<T = unknown>(
    js: string,
    matcher: (value: T) => boolean = (value) => value !== null && value !== undefined && value !== false,
    { intervalMs = 100, failure }: { intervalMs?: number; failure?: string } = {},
  ): T {
    const deadline = Date.now() + defaultWaitTimeoutMs()
    let lastValue: unknown = undefined
    let lastError: unknown = undefined
    for (;;) {
      try {
        const value = this.evaluate(js) as T
        lastValue = value
        lastError = undefined
        if (matcher(value)) return value
      } catch (cause) {
        lastError = cause
      }
      if (Date.now() >= deadline) break
      pause(intervalMs)
    }
    const reason: FailureReason = {
      kind: 'wait-value',
      expression: js,
      lastValue,
      ...(lastError !== undefined ? { lastError: describeError(lastError) } : {}),
    }
    const bundle = this.captureFailure(reason, lastError ?? new Error(`last value: ${summarize(lastValue)}`))
    const last = lastError !== undefined ? `last error: ${describeError(lastError)}` : `last value: ${summarize(lastValue)}`
    throw new WaitForValueError(
      `cezar e2e: ${failure ?? 'value never matched'}: ${js} (${last}) (failure bundle: ${bundle})`,
      js,
      lastValue,
      bundle,
      lastError !== undefined ? { cause: lastError } : undefined,
    )
  }

  /** operation: interact (`press`) — a key press against whatever currently has focus. */
  press(key: string): void {
    this.run(['press', key])
  }

  /** operation: interact (`wait <selector>`) — every interaction that takes a selector runs
   *  this first, so the seam waits the way Playwright's `locator.click()` does and no spec has
   *  to (#405).
   *
   *  agent-browser's `click`, `hover` and `fill` act at once: a target that is one request away
   *  from rendering (the health-gated Tools trigger behind a runs-driven list) is "Element not
   *  found", and the per-site `waitForFunction` that fixes it sits on a different request's DOM
   *  than the control it protects — the treadmill #369 and #393 ran on. `wait <selector>` is the
   *  CLI's own primitive: it blocks until the element is attached and has a non-zero box, and
   *  gives up after its default timeout (`AGENT_BROWSER_DEFAULT_TIMEOUT`, 25 s), which stays
   *  inside both `run()`'s 60 s kill and the suite's 60 s test timeout. Waits on a state rather
   *  than on existence (opacity, `aria-current`, a hover hit-test) are not covered and stay
   *  per-assertion.
   *
   *  `count`, `isVisible` and `evaluate` never go through here: they assert absence and a wait
   *  would turn "not there" into a 25 s timeout. */
  private awaitTarget(action: 'click' | 'hover' | 'fill', selector: string): void {
    try {
      this.run(['wait', selector])
    } catch (cause) {
      const bundle = this.captureFailure({ kind: 'wait-selector', action, selector }, cause)
      throw new Error(`cezar e2e: ${action} target never appeared: ${selector} (failure bundle: ${bundle})`, { cause })
    }
  }

  /** operation: interact (`fill`) — set a field's value the way typing would (real input
   *  events, so controlled React inputs — the ⌘K palette's filter — see the change).
   *  Waits for the field first; see `awaitTarget`. */
  fill(selector: string, value: string): void {
    this.awaitTarget('fill', selector)
    this.run(['fill', selector, value])
  }

  /** operation: interact (`mouse move`/`down`/`up`) — a tap at a viewport coordinate.
   *
   *  `click` targets an element's center point and, by design, refuses when something covers it.
   *  A modal backdrop is exactly that case: it spans the viewport, so its center sits under the
   *  drawer it is dimming, and the only honest way to tap the backdrop *beside* the drawer is by
   *  coordinate. */
  tapAt(x: number, y: number): void {
    this.run(['mouse', 'move', String(x), String(y)])
    this.run(['mouse', 'down'])
    this.run(['mouse', 'up'])
  }

  /** Send trusted wheel input at the current pointer position. */
  wheel(deltaY: number): void {
    this.run(['mouse', 'wheel', String(deltaY)])
  }

  /** Move a real pointer without clicking, for hover targets whose bounding-box center is covered. */
  moveTo(x: number, y: number): void {
    this.run(['mouse', 'move', String(Math.round(x)), String(Math.round(y))])
  }

  /** operation: interact (`mouse move`/`down`/`up`) — press at one viewport coordinate, move to
   *  another, release. A real, trusted pointer stream, which is the only kind that can exercise
   *  a drag built on pointer capture (`setPointerCapture` rejects a pointer id the browser is
   *  not actually tracking, so a synthetically dispatched PointerEvent cannot test one).
   *
   *  The intermediate move exists because a single jump from press to release is indistinguishable
   *  from a click for anything that samples movement — the sidebar's resize handle reads each
   *  move, so it needs more than one. */
  dragTo(from: { x: number; y: number }, to: { x: number; y: number }): void {
    this.run(['mouse', 'move', String(from.x), String(from.y)])
    this.run(['mouse', 'down'])
    this.run(['mouse', 'move', String(Math.round((from.x + to.x) / 2)), String(Math.round((from.y + to.y) / 2))])
    this.run(['mouse', 'move', String(to.x), String(to.y)])
    this.run(['mouse', 'up'])
  }

  /** operation: assert (`eval`) — for DOM facts no selector query can express, such as a
   *  computed style resolved from a CSS custom property. */
  evaluate(js: string): unknown {
    return this.run(['eval', js]).result
  }

  /** Serve deterministic API fixtures through Chrome's network layer, across document reloads. */
  routeJson(pattern: string, body: unknown): void {
    this.run(['network', 'unroute', pattern])
    this.run(['network', 'route', pattern, '--body', JSON.stringify(body)])
  }

  unroute(pattern: string): void {
    this.run(['network', 'unroute', pattern])
  }

  /** operation: interact (`set viewport`) — the descriptor's "other actions use the matching
   *  CLI command" clause. Responsive layout is a real behavior of this app, so the specs must be
   *  able to ask for an iPhone-sized window rather than assume the default one. */
  setViewport(width: number, height: number): void {
    this.run(['set', 'viewport', String(width), String(height)])
  }

  /** Actual browser network emulation, including online/offline events. */
  setOffline(offline: boolean): void {
    this.run(['set', 'offline', offline ? 'on' : 'off'])
  }

  /** Emulate the accessibility preference in the real browser, including CSS media queries. */
  setReducedMotion(): void {
    this.run(['set', 'media', 'reduced-motion'])
  }

  /** operation: interact (`click`). Waits for the target first; see `awaitTarget`. */
  click(selector: string): void {
    this.awaitTarget('click', selector)
    this.run(['click', selector])
  }

  /** operation: interact (`hover`) — hover-revealed affordances (the table's rename pencil)
   *  only exist under a real pointer; tests must produce one, not reach past it.
   *  Waits for the target first; see `awaitTarget`. */
  hover(selector: string): void {
    this.awaitTarget('hover', selector)
    this.run(['hover', selector])
  }

  /** operation: screenshot. The descriptor requires an absolute path — a relative
   *  multi-segment path is read as a selector by the CLI.
   *
   *  `viewport: true` captures the visible viewport only. Full-page capture stitches by
   *  scrolling through the document, which is both pathological on a virtualized thread and
   *  destroys scroll-dependent UI state (it re-pins the thread and unmounts the jump pill) —
   *  any spec asserting such state after the shot must use the viewport mode. */
  screenshot(path: string, { viewport = false } = {}): string {
    const absolute = resolve(path)
    mkdirSync(dirname(absolute), { recursive: true })
    this.run(viewport ? ['screenshot', absolute] : ['screenshot', '--full', absolute])
    if (statSync(absolute).size === 0) throw new Error(`cezar e2e: empty screenshot at ${absolute}`)
    return absolute
  }

  /** operation: close. Never throws — teardown must not mask a real failure. */
  close(): void {
    const index = attached.indexOf(this)
    if (index !== -1) attached.splice(index, 1)
    try {
      this.run(['close'])
    } catch {
      /* already closed */
    }
  }
}

/** An error's message with its cause chain, one line each — `run()` wraps the CLI's
 *  `Wait timed out after 25000ms` as a cause, and that line is the one worth keeping. */
function describeError(error: unknown): string {
  if (Array.isArray(error)) return error.map(describeError).join('\n---\n')
  const lines: string[] = []
  for (let current: unknown = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    lines.push(errorLine(current))
    current = typeof current === 'object' && 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return lines.join('\n  caused by: ')
}

/** One line for an Error, or for the plain `{ name, message }` object vitest serializes a test's
 *  errors into by the time `onTestFailed` sees them — not an Error instance, and with no
 *  prototype `String()` could fall back on. */
function errorLine(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const { name, message } = value as { name?: unknown; message?: unknown }
    return `${typeof name === 'string' ? name : 'Error'}: ${String(message)}`
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
