# Cockpit e2e specs

The specs in this directory drive the built cockpit in a real Chrome through the
`agent-browser` seam (`agent-browser.ts`). They run only via `npm run test:e2e`, never as
part of `npm test`. This page is about one thing: how a spec waits. Most red shards on `main`
and on unrelated pull requests have been sampling races, not product bugs (#369, #393, #394,
#405, #409), and every one of them looked like a flake until the page state was in hand.

## Wait, then read — as one step

agent-browser gives no implicit waits. `click`, `hover` and `fill` act at once, `eval`
reads at once, and the cockpit renders from requests that are still in flight when the
command lands. The seam closes that gap in two places:

| Primitive | What it waits for | What it returns |
| --- | --- | --- |
| `click` / `hover` / `fill` | The selector is attached with a non-zero box (`wait <selector>`, #405) | nothing |
| `waitForFunction(js)` | A predicate becomes truthy | nothing — **the read that follows is a second call** |
| `waitForValue(js, matcher?)` | An expression yields a value the matcher accepts (#409) | **that sample** |
| `waitForStable(js, { holdMs })` | The matcher holds across consecutive polls spanning `holdMs` (#415). `waitForValue` is this with `holdMs: 0`. | **the held sample** |

`waitForValue` is the one to reach for whenever a test needs a value the page has to reach
first. The value it hands back is the very sample the matcher accepted, so the state checked
and the state read are the same one. Use `waitForStable` when that first truth can leave
again inside one CLI round-trip — the hold is what `#409` could not see. The suite build
sets `VITE_CEZ_E2E=1` so `useNow` and every `refetchInterval` stay off, and the cockpit
exposes `window.__cezIdle` (false while a query, SSE reconcile, or WS topic is in flight). `hoverVisiblePoint` in `contrast.ts` is the worked
example: scroll, hit-test and the point come from one polled expression, and the pointer
moves to that point. Its predecessor polled a predicate and then recomputed the point in a
second `eval`, and any layout shift between the two failed as `no visible hover point`.

The default matcher accepts anything but `null`, `undefined` and `false`, so an expression
answers "not yet" with `null` and can still return `0` or `''` as a real value. A sample whose
expression throws (`querySelector(...)` was `null`) is a miss and is retried. On timeout it
fails through the failure bundle described below, with the expression and the last sample in
`probe.json`.

An overlay closed with Escape is not settled when its content is gone. Radix keeps a popover,
menu or dialog mounted through its exit animation and refocuses the trigger from a
`setTimeout(0)` scheduled when the content finally unmounts, so
`waitForFunction(\`querySelector(content) === null\`)` resolves one task BEFORE focus moves.
A scripted `.focus()` in that gap is undone a millisecond later, which is how the row-rename
pencil's Tab started from the Columns trigger and landed on "New task" (#410).
`dismissWithEscape(browser, { content, focus })` in `contrast.ts` presses Escape and waits for
both the absence and the returned focus; use it wherever a keyboard step or a focus assertion
follows a dismissal.

## The rules the ratchet enforces

`packages/web/src/test/e2e-wait-discipline.test.ts` scans every `.ts` file here (the seam and
the vitest config excepted) on every `npm test` and compares what it finds with
`e2e-wait-discipline.baseline.json`. The baseline holds the sites that existed when the ratchet
landed and it can only shrink. A new site fails the unit gate with the file, the rule and the
line; the fix is a wait, never a baseline entry.

1. **No one-shot read right after an action.** An `expect(browser.evaluate|count|isVisible|
   text|url(...))` within two lines after `click`, `hover`, `fill`, `press`, `goto`,
   `setViewport`, `moveTo`, `dragTo`, `tapAt`, `wheel`, `applyContrastQaVariant`,
   `dismissWithEscape`, `focusWithKeyboard` or `hoverVisiblePoint`, with no `waitFor…`/`settle…`
   call between
   them, is a sample of a page that is still loading. Put a `waitForFunction` on the state the
   assertion depends on, or read the value through `waitForValue` and assert on what it returns.
2. **No `:hover` inside a wait.** agent-browser moves the pointer over CDP, and that move does
   not set CSS `:hover` on wrapping inline elements (#369, #394). A wait on
   `matches(':hover')` times out at 25 s and proves nothing. Hover-revealed affordances are
   asserted through what they reveal (the pencil is in the DOM, its opacity resolved), never
   through the pseudo-class.
3. **No `scrollIntoView` inside a `waitForFunction` predicate.** A predicate that scrolls moves
   the layout that the read after it depends on. Scroll inside a `waitForValue` expression
   instead, where the same call reads the result, or scroll once in an `evaluate` and then wait.
4. **No sleep, anywhere in a spec.** `setTimeout` stands in for a condition nobody named. Name
   it. Waiting on the browser is `waitForFunction`/`waitForValue`; waiting on the SERVER is
   `poll.ts` — the shared module of HTTP polls (`waitForHealth`, `waitForStatus`,
   `waitForConfig`, `waitForServerAppearance`) built on one `pollFor` loop. It is the only file
   under `e2e/` the scan skips, and the only place a spec-side poll sleeps. Need a condition it
   does not cover? Call `pollFor` with your own probe; do not re-copy the loop (#416). The rule
   used to exempt any looping function whose name began `waitFor` or `poll`, which trusted a
   name rather than a mechanism.

5. **No write into a node React rendered.** A spec that rewrites a title, a status pill or a
   metric to reach a state is measuring something the product never produced — and `use-now.ts`
   re-renders those rows every 30 s, so the write races a re-render that puts the real value
   back under the measurement (#416). Build the state from fixture data: `runs.json` is cezar's documented
   state contract and the real store parses it. Where the state genuinely has no data path,
   stub the ROUTE the surface reads (`smoke.e2e.ts`'s nightly version, `github.e2e.ts`'s long
   titles) or add the seam in the product — never in the rendered DOM. Provenance decides what
   is exempt, not naming: a receiver rooted in `querySelector` is a rendered node, while
   `document.documentElement` (theme, density, width, accent) and anything bound to
   `document.createElement` or `.cloneNode` are the spec's own.
6. **No positional index into a rendered list, in a spec that addresses rows by `data-run-id`.**
   `rows[0]` and `links[1]` depend on a sort the fixture never pinned — two runs sharing a
   `createdAt` decide the order by V8's stable sort of the read order. Address the row by its id,
   the way the rest of the file already does; if the order itself is the subject, assert the whole
   order outright. Only in-page code counts: indexing an array `evaluate` RETURNED is reading a
   result, not addressing a row.

7. **No keyboard step or focus read after a bare `press('Escape')`.** A Radix overlay closed
   with Escape returns focus to its trigger one task after its content unmounts, so a wait for the
   content to be `null` settles inside that gap and the next `Tab` starts from the trigger
   (#410). Within twelve lines of a bare Escape, a `press('Tab'|'Enter'|'Space')`, a
   `focusWithKeyboard`, or a read of `activeElement`/`:focus` is flagged unless something settled
   focus first: `dismissWithEscape`, a wait that names `activeElement`, or a click, fill, tap or
   navigation that moves focus on its own. A dismissal in one helper and a Tab in another test are
   beyond a line scan; that case is why the helper exists, so use it for every dismissal a keyboard
   step follows.

8. **Stop fixture servers before removing their directories.** In an async `afterAll`, call
   `await stopFixtureServer(server)` before `rmSync(dataRoot, ...)`. The server flushes state after
   SIGTERM, so `kill()` alone does not settle cleanup. The helper waits for `exit` and sends
   SIGKILL if graceful shutdown takes more than five seconds. The unit check rejects bare
   fixture-server kills in e2e specs.

One site to know about: `selection-states.e2e.ts` asserts `matches(':hover')` after
`hoverVisiblePoint`. That is a one-shot assertion, not a wait, and it holds because that spec adds
`--blink-settings=primaryHoverType=2` to `AGENT_BROWSER_ARGS` before it attaches. Rule 1
lists it in the baseline as an unwaited read; rule 2 does not apply to it.

Shrinking the baseline after fixing a site:

```bash
E2E_WAIT_DISCIPLINE_UPDATE=1 npm test -- e2e-wait-discipline
```

That rewrites the file to what the suite has now and refuses to add anything. A site keyed by
its line text moves with a moved line; an edited line is a new site, and gets a wait.

## Reading a failure bundle

A red spec leaves `.ai/qa/failures/<spec>/<test>-<n>/` behind (#408), and CI uploads the
directory as the `cockpit-failures-shard-<n>` artifact:

| File | What it holds |
| --- | --- |
| `screenshot.png` | The viewport at the moment the wait gave up. Not full-page: stitching scrolls the document and moves what is being captured |
| `snapshot.txt` | The accessibility tree (`snapshot -i`) |
| `probe.json` | `kind` (`wait-selector`, `wait-fn`, `wait-value` or `test`), the selector, predicate or expression that timed out, the last sample for `wait-value`, the URL, the focused element's path, open dialogs, and for a selector its match count, rect, computed style and the element under its centre |

Read `probe.json` first. `target.count: 0` is a render that never happened; `count: 1` with
`elementUnderCentre.coversTarget: true` is an overlay; `inViewport: false` is a scroll that
did not happen; a `visibility: hidden` or `opacity: 0` in `style` is a transition mid-flight.
`activeElement` is what a `focusWithKeyboard` failure is about. A bundle from a wait inside
the test is the only bundle for that test; the `onTestFailed` hook writes one only for a
plain `expect` failure.

A flake fix that arrives without a bundle or a local reproduction is a guess, and the review
rules (`CODE_REVIEW.md`) send it back.

## Reproducing one test locally

The whole suite takes about 14 minutes; one test takes seconds.

```bash
env -u CEZ_AUTOMATIONS npm run test:e2e -- <spec>.e2e.ts -t '<test name>'
# Multiple spec filters and Vitest options work too:
npm run test:e2e -- smoke.e2e.ts composer.e2e.ts --force-rebuild
```

`CEZ_AUTOMATIONS` is unset because CI never sets it and four tests render differently with it.
The wrapper boots or reuses the environment, installs Chrome if needed, and exports
the browser's temporary-directory settings from `.ai/qa/test-env.json` (including
the socket-path workaround). `--force` and `--force-rebuild` go only to bootstrap;
other arguments, including `--shard=N/M`, spec paths and quoted test-name patterns,
are passed intact to Vitest. A literal `--` ends wrapper option parsing.
With no arguments the full sequential suite still runs. A filtered run's
`TEST_E2E_STATUS=passed` verifies only that selection, not the full browser gate.

## Full local suite in four lanes

Run `npm run test:e2e:local` for the complete suite on a machine with roughly **8 GiB
of free RAM**. It builds the E2E cockpit once, then runs four duration-weighted Vitest
shards (`--shard=1/4` through `4/4`) at the same time. The existing `npm run test:e2e`
command remains the single-environment runner used by CI and focused local runs.

Each lane is a temporary Git worktree at the current `HEAD` with this checkout's tracked
edits and untracked source files copied in. It gets a private `.ai/qa` directory, `CEZ_HOME`,
port, environment descriptor, and agent-browser namespace. `node_modules` and the two built
asset directories are symlinks to the source checkout; the lane bootstrap checks the E2E
build marker and cannot rebuild through those links. Do not edit source or rebuild the
shared assets while a four-lane run is active.

The command stops all four test servers and removes the worktrees when it finishes.
Shard output, boot logs, descriptors, app logs, and failure bundles remain under
`.ai/qa/local-runs/<run-id>/`. A failed lane makes the command exit nonzero and print
`TEST_E2E_STATUS=failed`; an unavailable browser prints `TEST_E2E_STATUS=skipped`.
Both statuses exit nonzero for this final local gate.

To force a race that CI hits and your machine does not, slow the server down behind an
environment variable rather than editing the spec. Specs that boot their own cezar spawn
`packages/cezar/dist/index.js`, so patch the built route in
`packages/cezar/dist/server/server.js`:

```js
// inside the handler the spec is racing, before it answers
if (process.env.E2E_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.E2E_DELAY_MS)))
```

Run the single test with `E2E_DELAY_MS=1500` and watch it go red the way CI did, fix the
wait, watch it go green, then restore `dist` (`npm run build`, or `git checkout` is no help
because `dist` is not tracked). Boot the env before patching: the first
`test-env-up.sh` in a fresh worktree runs `npm ci && npm run build` and would erase the patch.
The shared env's own server is not restarted by a `dist` patch; `--force-rebuild` is.

## Observable completion and budgets (#764)

`settleVisual(browser, target, { theme, width, idle })` waits for the intended appearance,
loaded fonts, non-zero target geometry, and completion of finite animations, then holds the
same target/descendant geometry and text across samples. Use it **before** overflow reads and
screenshots. Pair `idle: true` with the named route/target for ordinary completed navigation;
held loading fixtures must omit idle. Infinite loading spinners remain valid loading state.
For transition regressions, arm frame sampling before the trigger, observe the named loading
state and actual rendered frames before releasing the response, and keep sampling until the
ready/unavailable target settles. Final-state assertions alone cannot detect a transient jump.

HTTP `pollFor` probes receive an `AbortSignal`. Pass it through `fetch` and body reads (or use
`pollJson`); a cancelled probe must not leave a request running. `timeoutMs` bounds wall-clock
work, `requestTimeoutMs` bounds each probe, and `deadline` shares a test's remaining budget
between sequential polls. `tries` remains an additional cap for existing callers. The default
budgets remain 10 seconds for general polls, 15 for health, and 60 for status. Reserve part of
the enclosing test for browser actions, capture and cleanup; diagnostics consume a bounded
reserve inside the poll budget. Browser value polls also kill a CLI invocation within their
remaining monotonic deadline and reject late matching samples. Fixture teardown has a five
second grace and a five second kill acknowledgement bound, so hooks need at least that plus
browser close and filesystem cleanup (the suite's 60-second hook budget covers it).

The ratchet also scans packaged CLI E2E specs and helpers. It rejects elapsed-clock-only
`waitForFunction`/`waitForValue`/`waitForStable` calls, and permits reject-only observer deadlines.
Packaged fixtures' audited polling, shutdown simulation and process escalation timers carry
an adjacent `// e2e-wait: condition-poll|shutdown-grace|process-deadline — reason` annotation.
These annotations describe fixture mechanisms, never readiness; do not exempt an observation
sleep. HTTP request socket deadlines (`request.setTimeout`) are not unconditional sleeps.
