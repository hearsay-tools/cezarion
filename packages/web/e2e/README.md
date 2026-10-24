# Cockpit e2e specs

The specs in this directory drive the built cockpit in a real Chrome through the
`agent-browser` seam (`agent-browser.ts`). Run them via `npm run test:e2e`, or through
Squeal's slow tier when installed. The root Vitest config exposes the browser project,
and its `environment.ts` globalSetup uses the same environment bootstrap as the wrapper.
`npm test` and `npm run test:watch` select only the four unit projects. Browser results
are keyed by the server, cockpit and e2e sources that `squeal.config.json` lists as their
inputs, not by built output; CI owns the full gate.
This page is about one thing: how a spec waits. Most red shards on `main`
and on unrelated pull requests have been sampling races, not product bugs (#369, #393, #394,
#405, #409), and every one of them looked like a flake until the page state was in hand.

## QA screenshots of one element

Use `browser.screenshotElement(selector, path)` for viewport evidence of a specific
CSS-selected element. It centres the element in its scroll containers, waits for fonts,
finite animations and stable geometry, and checks that the whole box is in the viewport
with uncovered edges before taking the screenshot. This keeps a middle transcript card
away from the sticky task header (hearsay-tools/cezarion#1135).

```ts
browser.screenshotElement('[data-slot="hook-card"][data-status="completed"]', evidencePath)
```

The element must fit in the available viewport. Missing, oversized or covered targets
fail with the usual diagnostic bundle instead of producing misleading evidence. This
captures the viewport around the element, not a cropped element or a full-page image.
Use `browser.screenshot(path)` when the current viewport itself is the evidence.

## Wait, then read — as one step

agent-browser gives no implicit waits. `click`, `hover` and `fill` act at once, `eval`
reads at once, and the cockpit renders from requests that are still in flight when the
command lands. The seam closes that gap in two places:

| Primitive | What it waits for | What it returns |
| --- | --- | --- |
| `click` / `hover` / `fill` | The selector is attached with a non-zero box (`wait <selector>`, #405) | nothing |
| `setViewport` | An animation frame at the new size, so every native `matchMedia`/`resize` listener has run and its tree switch has committed (#794). `ResizeObserver`-driven state may still lag: wait on the DOM you read | nothing |
| `waitForFunction(js)` | A predicate becomes truthy | nothing — **the read that follows is a second call** |
| `waitForValue(js, matcher?)` | An expression yields a value the matcher accepts (#409) | **that sample** |
| `waitForSettledSample(browser, js)` | Fonts, native rendering, finite animations and stable geometry/focus, independently of the assertion (#795) | **the held measurement**, including `false` / `0` |
| `waitForStable(js, { holdMs })` | The matcher holds across consecutive polls spanning `holdMs` (#415). `waitForValue` is this with `holdMs: 0`. | **the held sample** |

`waitForValue` is the one to reach for whenever a test needs a value the page has to reach
first. The value it hands back is the very sample the matcher accepted, so the state checked
and the state read are the same one. Use `waitForStable` when that first truth can leave
again inside one CLI round-trip — the hold is what `#409` could not see. The suite build
(`.ai/scripts/build-e2e.sh`, into the ignored `.ai/qa/build/cezar`, never the production
`packages/cezar/dist`) sets `VITE_CEZ_E2E=1` so `useNow` and every `refetchInterval` stay off, and the cockpit
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

## Diagnosing flake causes

| Cause | How to confirm it |
| --- | --- |
| A late mount shifts the layout under a click | Use the [hearsay-tools/cezarion#1255 probe](https://github.com/hearsay-tools/cezarion/issues/1255): gate the request that mounts the late piece, log `pointerdown`, `focusin` and `click` targets together with its mount time, and release the gate in each gap of the click sequence described below. Compare event targets with the intended target and its original centre. |

agent-browser v0.36.0 reads the target's centre once, then sends separate CDP
`mouseMoved`, `mousePressed` and `mouseReleased` events at that point. It checks for
interception while resolving the centre, but does not hit-test again before the press. For the probe, hold `/api/v1/projects` while the health-gated Tools trigger
appears, record its centre, and mount the rail between the centre read and move,
between move and press, and between press and release in separate trials. Split the
sequence through `browser.withCdp` so the gate can be released at each boundary;
observe the rail mount before sending the next event, rather than sleeping. A press
can focus the theme toggle at the old centre while the intended trigger receives no
click. Wait for the layout-changing mount before the real click; target existence
alone cannot close this race. For coordinate probes through `tapAt`, round both
coordinates to integers: agent-browser's `mouse move` rejects decimals with
`Missing arguments for: mouse move`.

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
   fixture-server kills in e2e specs. A spec that starts its own fixture server declares the
   count on one line after its imports, `// fixture-server starts: N`, and a unit guard checks
   it (see `fixture-server.md`).

One more rule is enforced by review, not by the scan: **a wait added or changed to fix a flake
cites its evidence in the comment at the site.** The comment names the failure bundle path (or
the single-test reproduction that went red, with its command or delay) and the before/after run
counts. The evidence in a PR description or a review thread does not count: the next reader
meets the wait, not the PR, and the automated review sends a bare wait back
(hearsay-tools/cezarion#1000).

A local bundle path names evidence nobody else can open. `.ai/qa/failures/` is gitignored, and
a later run, a cleanup or a removed worktree deletes it. So write the full directory name (the
test segment is the test name with each run of characters other than letters, digits, `.`, `_`
and `-` turned into one `-`, cut to 80 characters, then `-<n>`), not a path shortened with `…`. Next to it, cite something that lasts:
for a CI failure, the run and its `cockpit-failures-shard-<n>` artifact (see
[Reading a failure bundle](#reading-a-failure-bundle)). For a local one, the PR comment that
records what the bundle's `probe.json` showed. `setViewport` in `agent-browser.ts` is the durable
form: "`cockpit-failures-shard-2` artifacts 11255134650, 11255508374 and 11259950580 (draft
PR #791)".

Copy this provenance comment and fill every part:

```ts
// <what changed and why>. Evidence: <spec> failed with "<headline>" (bundle
// .ai/qa/failures/<spec>/<test>-<n>/: probe.json <key fact>, snapshot.txt <key fact>;
// <durable citation>). Reproduce with `npm run test:e2e -- <spec>.e2e.ts -t '<name>'` —
// <failed> of <runs> failed before, <passed> of <runs> passed after.
```

Three parts are required, and review checks each one (hearsay-tools/cezarion#1093):

| Part | Write |
| --- | --- |
| Bundle leaf path | The full `<spec>/<test>-<n>/` directory, named by the rule above, never the `<spec>/` parent. Add the durable citation next to it: the CI run id and its `cockpit-failures-shard-<n>` artifact, or the PR comment for a local bundle. A red run of the reproduction writes a bundle too (`failure-setup.ts` for any failed test with a browser attached, the seam when a wait gives up), so name that bundle. |
| Reproduction command | The single-test recipe from [Reproducing one test](#reproducing-one-test-locally), or the env-gated delay that made it red. |
| Before/after counts | Both totals: how many of how many runs failed without the change, and how many of how many passed with it ("2 of 6", "8 of 8" below). A bare count cannot tell 2 of 6 from 2 of 200, nor show whether an after-run still failed. |

The worked example for the counts is `liftWithSpace` in `project-order.e2e.ts`, quoted as it
stands:

```ts
 *  Provenance (hearsay-tools/cezarion#438, local, 2026-10-13): with a one-shot
 *  `waitForFunction(data-dragging)` here instead, the collapsed-mark test failed 2 of 6 full-spec
 *  runs of `npm run test:e2e -- project-order.e2e.ts`. Failure bundles
 *  `.ai/qa/failures/project-order/reorders-a-collapsed-mark-…-20` and `-22` both time out on
 *  `"e2e-order-a moved to position 3 of 4."` with focus on the lifted mark's link: the row was
 *  lifted, the key reached the activator, and dnd-kit never saw it. The single test alone passed
 *  4 of 4, because the earlier tests' load is what widens the gap. With this hold: 8 of 8 full-spec
 *  runs passed.
```

It names the command, what the bundles' `probe.json` showed, the before count (2 of 6) and the
after count (8 of 8). It also shows the gap this rule now closes. The paths are shortened, and the
bundles were local and are gone. The naming rule spells them out as
`.ai/qa/failures/project-order/reorders-a-collapsed-mark-from-the-keyboard-with-Space-leaving-Enter-to-the-link-20`
and
`.ai/qa/failures/project-order/reorders-a-collapsed-mark-from-the-keyboard-with-Space-leaving-Enter-to-the-link-22`.
Those names are derived from the rule, not read from disk. What survives is the
diagnosis recorded in the comment and in the hearsay-tools/cezarion#999 review reply from
commit `740b35ff`. A reproduction stands in for a bundle the same way:
`task-handoff.e2e.ts`'s `window.__cezLive` wait cites "Reproduced 3/3 by delaying the built
server's workspace-events attach 4 s behind E2E_DELAY_MS; 0/3 with this wait"
(hearsay-tools/cezarion#1069). Anyone can rerun that from the
[single-test recipe](#reproducing-one-test-locally).

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

Each selected spec clears its own old bundle directory before its setup starts. Bundles from
unselected specs remain. Archive evidence you need before rerunning its spec. All captures and
retries from the current spec execution remain, with increasing `-<n>` suffixes. Cleanup errors
fail setup rather than mix revisions. Parallel local lanes use separate worktrees; do not run
independent browser suites concurrently in the same checkout and shared test environment.
Plain assertion failures print `(failure bundle: <dir>)` alongside the original assertion.

For layout assertions, record named CSS selectors immediately before the assertion block:

```ts
browser.recordLayout('expanded', {
  card: '[data-slot="run-activity-dock"]',
  meta: '[data-slot="run-activity-meta-keep"]',
})
expect(expanded.metaCut).toEqual([])
```

A failure bundle then also contains `layout.json`, with every labelled sample from that test
attempt. Each sample records its time, session, URL, viewport, selector match counts, element
rectangles, scroll/client widths and heights, and nearest overflow-clipping ancestor box and
axes (or `null`). Missing selectors have zero matches; invalid selectors and failed reads have
an error. Measurements are read-only and are not assertion retries. They precede the assertion;
they are not an atomic snapshot of an earlier `evaluate()` result. Reuse labels such as
`folded` and `expanded` to distinguish states. Samples reset for each test and retry, and no
layout file is written for tests that did not request measurements. Capture failures remain
best-effort and never replace the assertion failure.

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
npm run test:e2e -- <spec>.e2e.ts -t '<test name>'
# Multiple spec filters and Vitest options work too:
npm run test:e2e -- smoke.e2e.ts composer.e2e.ts --force-rebuild
# Boot the shared server with an opt-in feature on (repeatable):
npm run test:e2e -- inbox.e2e.ts --server-env=CEZ_FOLLOWUPS=1
```

No ambient `CEZ_*` variable reaches an e2e cockpit (hearsay-tools/cezarion#1045), so a run from
an agent's shell, which inherits the live cockpit's `CEZ_PREVIEW=1` and `CEZ_AUTOMATIONS=1`,
boots what CI boots. The shared server takes opt-ins only from `--server-env=CEZ_NAME=value`,
and a running server booted with a different set is replaced rather than reused. A spec that
boots its own server passes its flags in `fixtureServeEnv(root, { … })`.
The wrapper boots or reuses the environment, installs Chrome if needed, and exports
the browser's temporary-directory settings from `.ai/qa/test-env.json` (including
the socket-path workaround). `--force`, `--force-rebuild` and `--server-env` go only to bootstrap;
other arguments, including `--shard=N/M`, spec paths and quoted test-name patterns,
are passed intact to Vitest. A literal `--` ends wrapper option parsing.
With no arguments the full sequential suite still runs. A filtered run's
`TEST_E2E_STATUS=passed` verifies only that selection, not the full browser gate.

The launcher waits up to 180 elapsed seconds for app health after starting the server.
Set `TEST_ENV_HEALTH_TIMEOUT_SECONDS` to a positive integer to override that budget
(for example, `TEST_ENV_HEALTH_TIMEOUT_SECONDS=5 npm run test:e2e -- smoke.e2e.ts`).
Unset or empty values use the default; malformed values fail before boot. Each HTTP
probe is bounded by the remaining budget. On timeout the launcher prints elapsed
seconds and the last 20 lines of `.ai/qa/test-env-app.log`, then stops the app.
This budget covers the health wait, excluding build and browser preparation.

The server stays up after the run so the next run can reuse it, but it does not stay up for
ever (hearsay-tools/cezarion#1448). A watcher process next to it stops it when the checkout or
the served clone is deleted, or after `TEST_ENV_IDLE_EXIT_MINUTES` (default 30) with no
test-env lease holder; `0` turns the idle exit off. A run killed with SIGKILL leaves dead
holder rows, which the watcher removes, so the idle period still runs out.
`TEST_ENV_WATCH_INTERVAL_SECONDS` (default 30, from 0.1 to 3600) sets how often it checks. Malformed values fail
before boot; unset or empty values use the defaults. The watcher reads them once, when the server
boots, so a run with different values does not reuse the running server: it boots a new one
under the new values. The watcher logs why it stopped a server to `.ai/qa/test-env-watch.log`.

## The project the shared env serves

The shared server never serves this checkout. Each cold boot serves a fresh isolated clone at
`.ai/qa/served/<checkout name>`, made by `.ai/scripts/e2e-served-repo.mjs` with the same
construction as a local lane: own objects and refs, current `HEAD`, plus this checkout's tracked
edits and untracked source files. The descriptor records it as `servedRoot`. The server's runs,
task worktrees and `.ai/cezar` state live there. Serving the checkout put them in the checkout's
own `.ai/cezar`, and in the main checkout that is the live cockpit's data dir: the cockpit refused
the second server (`A cockpit already serves …`), and a boot that got through would have written
test runs into it. A lane is already such a clone and serves itself. A reused server keeps
reading the clone live, as it read the checkout: each `test-env-up.sh` that reuses it first
syncs the clone to the checkout's current edits (`--sync`), and a moved `HEAD` cold-boots
with a fresh clone.

A spec that seeds state for the server to read — skills, workflows, `.ai/cezar/config.json`,
a registry root for the boot project — writes it under `servedRoot()` from `agent-browser.ts`,
never under a path derived from `import.meta.dirname`. The server never reads those paths.
Evidence and artifacts stay in this checkout's `.ai/qa`.

A cold boot deletes the previous descriptor before it starts anything. If the boot then fails,
specs report that no env exists and point at `.ai/qa/test-env-app.log`. Before this change they
attached to the old env's dead `baseUrl` and repeated its browser notes.

Seeded NDJSON transcripts must go through `seedTranscript` from `seed-transcript.ts`; every nonblank line needs `seq` and `ts` (and `type`), and validation reports the line number and event type before writing.

## A plain dry-run reply parks on a "Next step" card

A dry-run task whose reply has no marker does not park with the composer alone. Cezar's no-wait
nudge (hearsay-tools/cezarion#1234) asks the mock again, and every native mock answers the nudge
with a "Next step" question card. `packages/cezar/scripts/mock-nudge.mjs` is the source of that
card. A spec that needs a task parked `waiting` with no question card sets
`CEZ_MOCK_NUDGE_REPLY=plain` on its fixture server: the mocks then answer the nudge in plain text,
and the run reaches the no-wait fallback. A spec that boots its own server passes
`fixtureServeEnv(root, { CEZ_MOCK_NUDGE_REPLY: 'plain' })`, as `voice.e2e.ts` does. On the shared
server, pass `--server-env=CEZ_MOCK_NUDGE_REPLY=plain`.

## Full local suite in four lanes

Run `npm run test:e2e:local` for the complete suite on a machine with roughly **8 GiB
of free RAM**. It builds the E2E cockpit once, then runs four duration-weighted Vitest
shards (`--shard=1/4` through `4/4`) at the same time. The existing `npm run test:e2e`
command remains the single-environment runner used by CI and focused local runs.

Each lane is a temporary checkout at the current `HEAD`, with independent Git administration
and owned objects, plus this checkout's tracked edits and untracked source files copied in. It gets a private `.ai/qa` directory, `CEZ_HOME`,
port, environment descriptor, and agent-browser namespace. `node_modules` and the E2E build
(`.ai/qa/build`) are symlinks to the source checkout; the lane bootstrap checks the E2E
build marker and cannot rebuild through those links. Do not edit source or rebuild the
shared assets while a four-lane run is active.

Remote projection reads only repository-local and enabled worktree configuration. Global
and system remote declarations are not copied. If an inherited declaration shares a local
remote's name, setup refuses it before construction because Git's effective URL lookup
would mix the scopes. Safe inherited URL rewrite rules still apply without copying their
configuration.

The command stops all four test servers and removes the temporary checkouts when it finishes.
Shard output, boot logs, descriptors, app logs, and failure bundles remain under
`.ai/qa/local-runs/<run-id>/`. A failed lane makes the command exit nonzero and print
`TEST_E2E_STATUS=failed`; an unavailable browser prints `TEST_E2E_STATUS=skipped`.
Both statuses exit nonzero for this final local gate.

To force a race that CI hits and your machine does not, delay the built route that the
spec races. The shared env and specs that boot their own cezar (`cezarCli`) both run
`.ai/qa/build/cezar`. Use the shared env in this order, from the repository root:

1. Boot once so the build exists:

   ```bash
   sh .ai/scripts/test-env-up.sh
   ```

2. Patch the handler in `.ai/qa/build/cezar/dist/server/server.js`, before it answers
   (make the handler `async` if needed):

   ```js
   if (process.env.CEZ_E2E_DELAY_MS) {
     await new Promise((r) => setTimeout(r, Number(process.env.CEZ_E2E_DELAY_MS)))
   }
   ```

3. Restart the shared server with the explicit variable, then run the focused test:

   ```bash
   sh .ai/scripts/test-env-up.sh --force --server-env=CEZ_E2E_DELAY_MS=1500
   npm run test:e2e -- <spec>.e2e.ts -t '<test name>'
   ```

   `--force` restarts the server and preserves the cached build when its source inputs
   have not changed. Do not use `--force-rebuild` here: it erases the patch. The first
   boot also builds when needed, which is why it must precede patching. Editing a loaded
   module does not change the running server. Setting the variable only on the test
   command does not change that server's environment; ambient `CEZ_*` variables are
   scrubbed at boot, so pass the value through `--server-env`.

4. Watch the test fail at the intended race, fix its wait, then rerun it against the
   delayed route. When finished, rebuild and restart without the variable:

   ```bash
   sh .ai/scripts/test-env-up.sh --force --force-rebuild
   ```

   This removes the patch and the explicit server variable. The build is ignored, so
   `git checkout` cannot restore it. Source edits that invalidate the build cache also
   remove the patch on the next boot; reapply it after rebuilding if needed.

For a chosen release moment instead of a fixed delay, use a file gate as in
hearsay-tools/cezarion#1255. Remove the gate file before boot, then replace the delay
snippet with this bounded wait in the handler:

```js
if (process.env.CEZ_E2E_GATE_FILE) {
  const { access } = await import('node:fs/promises')
  const deadline = Date.now() + 30_000
  while (true) {
    try { await access(process.env.CEZ_E2E_GATE_FILE); break } catch {}
    if (Date.now() >= deadline) throw new Error('E2E file gate timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
```

Restart with `--force --server-env=CEZ_E2E_GATE_FILE=/tmp/cez-e2e-1276.ready`
(use a unique absolute path for your run). Trigger the request, observe or capture the
loading state, then `touch /tmp/cez-e2e-1276.ready` from another shell to release the
response and mount the late UI piece. Choose a route other than health so bootstrap can
finish before release. Remove the file afterwards and use step 4's rebuild to drop the
patch. This variable is temporary instrumentation in the ignored build, not a cezar setting.

## Observable completion and budgets (#764)

`settleVisual(browser, target, { theme, width, idle })` waits for the intended appearance,
loaded fonts, non-zero target geometry, and completion of finite animations, then holds the
same target/descendant geometry and text across samples. Use it **before** overflow reads and
screenshots. Pair `idle: true` with the named route/target for ordinary completed navigation;
held loading fixtures must omit idle. Infinite loading spinners remain valid loading state.
For transition regressions, arm frame sampling before the trigger, observe the named loading
state and actual rendered frames before releasing the response, and keep sampling until the
ready/unavailable target settles. Final-state assertions alone cannot detect a transient jump.

`waitForSettledSample` composes the same visual readiness with the measured expression in
one browser task. Keep expected line heights, contrast, viewport coverage and focus-visible
results in assertions, not readiness matchers. For lazy transcript geometry, observe
`checkVisibility({ contentVisibilityAuto: true })` before any box read, scroll the target
into view, and reject the sample until native rendering is observable on a later frame.
See [the exhaustive #795 audit](settle-wait-audit-795.md) for sites and red/green evidence.

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

## Screenshots capture the viewport (hearsay-tools/cezarion#1046)

`browser.screenshot(path)` captures the viewport. agent-browser's full-page capture resizes
the window to 1x1 and back, so the `md` breakpoint flips for a frame and any subtree that
switches on it can remount, losing an open dialog, popover, menu or focus
(hearsay-tools/cezarion#979). A cockpit page never needs it: `html, body` are
`overflow: hidden` and the shell is `h-dvh`, so the document is exactly the viewport.
`{ full: true }` exists for a page whose document really scrolls, and the seam refuses it
while an overlay is open. `{ viewport: true }` on older call sites is now redundant.

## Driving dnd-kit sortables (hearsay-tools/cezarion#1001)

A dnd-kit sortable measures, attaches and announces asynchronously, and agent-browser sends a
whole drag in a few milliseconds. The project rail's reorder (hearsay-tools/cezarion#438) took
about 40 single-spec runs to stabilize against four races. The next sortable will meet the same
four; each has a fix already in the tree:

| Race | What happens | What handles it |
| --- | --- | --- |
| Drop targets measured only after the lift | dnd-kit's default `MeasuringStrategy.WhileDragging` measures droppables in an effect after the drag starts, so a quick pointer release or an early arrow key resolves to no target and the drop silently does nothing | Product side: the rail passes `measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}` (`RAIL_MEASURING` in [`project-rail.tsx`](../src/components/project-rail.tsx)). Spec side: [`AgentBrowser.dragHeld`](agent-browser.ts) waits for the drop to resolve before releasing |
| The keyboard listener attaches late | `@dnd-kit/core` 6.3.1 `KeyboardSensor.attach` adds its keydown listener in a `setTimeout` after the lift. The row is marked lifted at once, so an arrow sent as soon as `data-dragging` appears is dropped | `liftWithSpace` in [`project-order.e2e.ts`](project-order.e2e.ts): press Space, then `waitForStable` on `data-dragging` with `holdMs: 150`. A held sample spans a poll interval, which the zero-delay timer has always run inside |
| The live region holds only the newest announcement | The `DndLiveRegion-*` element renders one string that each announcement replaces, so the "Picked up …" text can be gone before a poll reads it and a wait on it never matches | Wait for the lift on `data-dragging` (above), and wait for each move on its OWN announcement (below), never on an earlier one |
| Keys sent back to back lose moves | A second arrow lands before the sortable has processed the first move, and one step is lost | `pressAndHear` in [`project-order.e2e.ts`](project-order.e2e.ts): press one key, then wait until a `[id^="DndLiveRegion"]` element contains that key's announcement (`"<id> moved to position 3 of 4."`, `"<id> dropped at position 2 of 4."`) before the next |

For a pointer drag use `dragHeld(from, to, { lifted, over })` instead of `dragTo`: it presses,
moves ten pixels, waits for `lifted`, moves through the midpoint to the target, waits for `over`,
then releases (in a `finally`, so a timed-out wait never leaves the button down). In the rail,
`lifted` is the mark's `data-dragging` attribute and `over` is the live region announcing the
target position, which proves the targets were measured. Take both points from one
`waitForValue` that also checks the rows are laid out, as `project-order.e2e.ts` does.

For a keyboard drag: focus the activator with `focusWithKeyboard`, `liftWithSpace`, one
`pressAndHear` per arrow, and a final `pressAndHear` for the drop key. Then read the order from
the DOM and from the server, not from the announcement. A sortable whose lift key is not Space,
or whose announcements differ, needs its own pair of helpers in the same shape. If a second spec
needs them, move them into a shared module rather than copying them.


## Browser-tab connection benchmark

`tab-coordination.e2e.ts` uses one agent-browser profile and real HTTP/1.1 tabs/windows.
Its private fixture boots production server modules and exposes test control on a
separate loopback listener. CDP observation stays inside `AgentBrowser.withCdp`.

For an additional tab that a separate CDP connection will navigate, `browser.newTab()`
returns the target ID after the provider initializes it. The provider pauses new targets
until its daemon enables their domains and resumes them; raw `Target.createTarget` can
race that work and leave `Page.navigate` waiting on a paused target. The live-preview
spec uses the native tab operation, and `agent-browser-tabs.e2e.ts` holds a private
daemon's background drain to pin this ordering without a sleep.

Run the performance harness against a **production** build (omit `VITE_CEZ_E2E`):

```sh
npm run build
node --import tsx packages/web/scripts/benchmark-tabs.ts --output .ai/qa/tabs-after.json
```

The default matrix is overview/repeated task/distinct projects × 1/3/6/10 tabs ×
idle/20 events per second per run, with 5 s warmup and 20 s samples. `--build-root DIR`
uses an independently installed/built baseline checkout; the same fixture drives both
versions. `--windows` uses simultaneous native windows. `--quick` is a short harness
smoke, not performance evidence. Keep raw failed requests and actual visibility states.
See [the report](../../../docs/performance/browser-tab-coordination.md).


For a smaller full-duration visible-window supplement, use
`--windows --workload distinct --counts 1,10`. Unlike `--quick`, these selectors
retain the five-second warmup and 20-second sample. The measured report and raw
samples live in [`docs/performance/browser-tab-coordination.md`](../../../docs/performance/browser-tab-coordination.md).
