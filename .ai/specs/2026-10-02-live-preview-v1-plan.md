# Live preview v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent registers its dev server with `cezar_preview_serve`; the owner runs it and clicks through it in a per-task headless Chromium docked next to the task (#781).

**Architecture:** A workspace-wide `PreviewHost` in the server process owns every cezar-started dev server and every task's Chromium, keyed by run id. Agents reach it through the existing private tool socket; the cockpit reaches it through one same-origin WebSocket per open pane, carrying JPEG screencast frames down and a whitelisted input vocabulary up. Everything is gated by `CEZ_PREVIEW=1`.

**Tech Stack:** TypeScript (ESM, Node >=20), Hono, zod, `ws`, `@modelcontextprotocol/sdk`; React 19 + Tailwind v4 + shadcn/ui; vitest; agent-browser e2e.

**Spec:** `.ai/specs/2026-10-02-live-preview-v1.md` (state numbers 5.1 to 5.18 refer to the v1 design screens, kept outside the repo). Prototype to port: `/home/agent/projects/cdp-screencast-proto/` (`server.mjs`, `client.html`).

## Global Constraints

- `CEZ_PREVIEW=1` exactly enables the feature; any other value is off. Off removes the tool listing, the tool route answer, the WebSocket path and `capabilities.preview`.
- `CEZ_PREVIEW_NO_SANDBOX=1` exactly adds `--no-sandbox`; nothing else ever adds it (not root, not containers).
- Both env vars land in `.env.example` and the README env table in the commit that first reads them.
- Constants: `PREVIEW_SERVER_IDLE_MS = 15 * 60_000`, `PREVIEW_BROWSER_IDLE_MS = 2 * 60_000`, `PREVIEW_PORT_WAIT_MS = 2 * 60_000`, `PREVIEW_PROBE_MS = 2_000`, `PREVIEW_MAX_SERVERS = 8`, reconnects: 5 after a frame, 2 before any frame.
- Raw CDP never leaves the server; Chromium binds `--remote-debugging-port=0` on loopback.
- Dev servers: own process group, `cwd` inside the worktree, stdin `'ignore'`, cezar kills only pids it recorded.
- Every request/response/message shape is a zod schema in `packages/contract`; types are `z.infer`. New routes are chained into a family builder and validated as middleware (AGENTS.md "The HTTP API").
- `RunRecord.previewServers` is optional and salvaged per entry, so old `runs.json` files parse.
- Copy rules: no em-dashes in UI copy; state copy is the v1 design's, except the spec's "Design deltas".
- Cockpit: light/dark, AA contrast, 44 px targets at 390 px width, reduced motion keeps feedback.

## Decisions made while planning (fold into the spec in Task 1)

- **The server card is a cezar thread entry, not the tool-call row.** Five runners name MCP tool calls five ways; `thread-state.ts` already reduces cezar run events (`webhook.failed`) into entries. Registration appends `preview.server-registered`; state changes append `preview.server-state`. The card renders where the registration event lands, which is right after the tool call.
- **Event names** follow the dotted convention: `preview.server-registered { server }`, `preview.server-state { port, state, exitCode?, reason? }`.
- **Chrome for Testing publishes no linux-arm64 build.** On that platform 5.1 shows only the OS install command, no Download button.
- **One `PreviewHost` per server process**, not per project: ports are host-global, so `port_held` must see every project's servers.

## Review Focus

- A dev server that listens only on `::1` (Vite resolving `localhost` to IPv6) must count as answering; the probe tries `127.0.0.1` and `::1`. Test in Task 4.
- Stop must free the port when the command forks (`npm` → `node` → `vite`): kill the process group, not the pid. Test in Task 4.
- A click on a fixed viewport scaled to 83% must land on the same page pixel: input coordinates divide by the display scale. Test in Task 10.
- The URL bar rejects `javascript:`, `file:`, `chrome:` and `data:` and expands a bare port to `http://localhost:<port>`. Test in Task 6.
- On linux-arm64 the Download button is absent and the OS command shows instead. Test in Task 5.

---

### Task 1: Contract, capability and run-record field

**Files:**
- Create: `packages/contract/src/preview.ts`
- Modify: `packages/contract/src/index.ts`, `packages/contract/src/health.ts` (capabilities), `packages/contract/src/runs.ts:179`, `packages/cezar/src/runs/store.ts:162` and its salvage block near `:359`, `packages/cezar/src/server/capabilities.ts:141`
- Modify: `.env.example`, `README.md` env table, `.ai/specs/2026-10-02-live-preview-v1.md` (the four planning decisions)
- Test: `packages/contract/src/preview.test.ts`, `packages/cezar/src/server/capabilities.test.ts`, `packages/cezar/src/runs/store.test.ts`

**Interfaces:**
- Produces (all zod, types inferred):
  - `previewServeRequestSchema`: `{ command: string 1..1024, port: int 1..65535, cwd?: string, label?: string 1..48, path?: string starting '/' }`
  - `previewResultCodeSchema`: enum `registered | replaced | invalid_input | cwd_outside_worktree | cezar_port | port_held | too_many | preview_disabled | headless | worktree_missing | unavailable`
  - `previewServeResultSchema`: `{ ok: boolean, code, message: string, hint: string }`
  - `previewServerSchema` (run record entry): `{ port, command, cwd?, label, path?, registeredAt: iso, answeredAtRegistration: boolean }`
  - `previewServerStateSchema`: enum `registered | starting | up | stalled | exited | stopped | adopted | unavailable`
  - `previewClientMessageSchema` (discriminated on `t`): `open { target: { port } | { url } }`, `run { port }`, `stop { port }`, `keepWaiting { port }`, `resize { w, h }` (clamped 100..4000), `mouse {...}`, `key {...}`, `insertText { text }`, `nav { url }`, `back`, `forward`, `reload { ignoreCache?: boolean }`, `dialogResult { accept, text? }`, `ack`, `ping { ts }`, `download`, `cancelDownload`, `retryBrowser`. Mouse/key field sets as in the prototype's `handle()`.
  - `previewServerMessageSchema` (discriminated on `t`): `state` discriminated on `stage`: `chromium-missing { installCommand, canDownload }`, `downloading { received, total }`, `download-failed { error, installCommand }`, `sandbox-failed { stderrTail }`, `browser-exited { signal?, stderrTail, serverUp: boolean }`, `needs-approval { server, wasRunning: boolean }`, `server-starting { server, attempt, startedAt }`, `server-stalled { server, logTail }`, `server-exited { server, exitCode, logTail }`, `server-stopped { server, reason, lastUrl }`, `worktree-removed { server? }`, `loading { step: 'browser' | 'page' | 'frame' }`, `streaming { adopted: boolean }`. Connection lost (5.11), taken over (5.12) and proxy blocked (5.14) are client transport states, not server stages, `url { url }`, `cursor { cursor }`, `dialog { type, message, defaultPrompt?, origin }`, `replaced { by: string }`, `pong { ts }`, `downloadProgress { received, total }`
  - `capabilitiesSchema.preview: z.boolean()` (required, this server always sends it)
  - `RunRecord.previewServers?: PreviewServer[]`

- [ ] **Step 1: Write failing tests**: `preview.test.ts` asserts `previewServeRequestSchema` rejects `port: 0`, `port: 65536`, `command: ''`, a 1025-char command, `path: 'members'`; accepts the spec's example `{ command: 'npm run dev -- --port 5173 --strictPort --host 127.0.0.1', port: 5173, cwd: 'apps/web', label: 'web', path: '/members' }`; `previewClientMessageSchema` rejects `{ t: 'eval' }` and `{ t: 'mouse', type: 'mouseTeleport' }`. `capabilities.test.ts`: `resolveCapabilities({ CEZ_PREVIEW: '1' }).preview === true`, `'true'` and unset give `false`. `store.test.ts`: a `runs.json` row with one valid and one malformed `previewServers` entry loads with the valid entry kept.
- [ ] **Step 2: Run** `npm test -- packages/contract/src/preview.test.ts packages/cezar/src/server/capabilities.test.ts packages/cezar/src/runs/store.test.ts`; expect FAIL (module missing / property missing).
- [ ] **Step 3: Implement** the schemas, `preview: env.CEZ_PREVIEW === '1'` in `resolveCapabilities`, the optional run-record field with per-entry salvage in the store, the `.env.example` block for both vars (format of the `CEZ_AUTOMATIONS` block), the README rows, and the spec edits listed under "Decisions made while planning".
- [ ] **Step 4: Run** the same command plus `npm test -- contract-parity`; expect PASS.
- [ ] **Step 5: Commit** `feat(contract): live preview schemas and CEZ_PREVIEW capability (#781)`

### Task 2: Shared cezar tool list and the private preview route

**Files:**
- Create: `packages/cezar/src/ci-wait/tools.ts` (the one list of cezar tools)
- Modify: `packages/cezar/src/ci-wait/mcp.ts`, `packages/cezar/src/ci-wait/controller.ts:58-110`, `packages/cezar/src/ci-wait/client.ts`, `packages/cezar/scripts/pi-ci-wait.mjs`, `packages/cezar/src/core/claude-cli-runner.ts:533-537`, `packages/cezar/src/core/pi-runner.ts` (tool admission), `BACKWARD_COMPATIBILITY.md` §"Private CI tool IPC (#474)"
- Test: `packages/cezar/src/ci-wait/mcp.test.ts`, `packages/cezar/src/ci-wait/contract.test.ts`, `packages/cezar/src/core/harness-parity.test.ts:1353`

**Interfaces:**
- Consumes: Task 1 schemas.
- Produces:
  - `cezarTools(env = process.env): Array<{ definition: { name, description, inputSchema }, trigger: string }>`; includes `cezar_preview_serve` only when `env.CEZ_PREVIEW === '1'`.
  - `cezarToolNames(env): string[]` used by every allow-list or admission site.
  - Capability gains `registerPreview?: (request: PreviewServeRequest) => Promise<PreviewServeResult>`; `provision(register, registerPreview?)`.
  - Route `POST /api/v1/tools/preview-serve` on the private socket, same bearer middleware, `bodyLimit` 16 KiB, `jsonZodValidator(previewServeRequestSchema)`; an invalid body answers `200` with `{ ok: false, code: 'invalid_input', message, hint }` naming the first failing field (the agent needs the hint, not a 400).
  - `invokePreviewTool(input): { content: [{ type: 'text', text: JSON + '\n' + hint }], isError: !ok }`.
- Trigger line: `load when you have started, or are about to start, a web server the user should click through.` Description: the spec's text, including "pin the port (`vite --strictPort`, `next dev -p`)".

- [ ] **Step 1: Write failing tests**: `mcp.test.ts`: with `CEZ_PREVIEW=1` the listed tool names are `['cezar_wait_for_ci', 'cezar_preview_serve']` and the instructions carry both trigger lines; unset lists only the CI tool. `contract.test.ts`: posting `{ port: 'x' }` with a valid token returns `ok: false, code: 'invalid_input'` and a hint containing `"port"` and the example call; a missing token returns 401. Extend the `cezarTools` cell in `harness-parity.test.ts` so every `RUNNER_IDS` runner, through its own native mock wire, exposes `cezar_preview_serve` with the flag on and not with it off (Claude: the generated `--allowedTools` entry `mcp__<name>__cezar_preview_serve` too).
- [ ] **Step 2: Run** `npm test -- packages/cezar/src/ci-wait packages/cezar/src/core/harness-parity.test.ts`; expect FAIL.
- [ ] **Step 3: Implement**: move the tool list and instructions into `tools.ts`, make `mcp.ts`, Pi's extension and Claude's allow-list read `cezarToolNames`, add the route and `invokePreviewTool`. Keep the MCP server name prefix `cezar_ci_` (existing runs and mocks match it).
- [ ] **Step 4: Prove the parity test is load-bearing**: `git stash push -u -m lp-task2 -- packages/cezar/src/ci-wait packages/cezar/src/core/claude-cli-runner.ts packages/cezar/src/core/pi-runner.ts packages/cezar/scripts/pi-ci-wait.mjs`, run the parity test, confirm red, `git stash apply` the captured SHA, drop it. Then run Step 2's command; expect PASS.
- [ ] **Step 5: Commit** `feat(cezar): cezar_preview_serve tool on every runner (#781)`

### Task 3: Registration semantics in RunManager

**Files:**
- Modify: `packages/cezar/src/workflows/run.ts` (next to `provisionCiSession` `:1412` and `registerCiWait` `:1426`)
- Create: `packages/cezar/src/preview/registration.ts` (pure validation and hint text)
- Test: `packages/cezar/src/preview/registration.test.ts`, `packages/cezar/src/workflows/run-preview.test.ts`

**Interfaces:**
- Consumes: Task 2 `provision(register, registerPreview)`; Task 6 `PreviewHost.portOwner(port): { runId, title } | undefined` and `PreviewHost.probe(port): Promise<boolean>`.
- Produces:
  - `validateRegistration(input: { request, worktreePath?: string, cezarPort?: number, existing: PreviewServer[], owner?: { runId: string; title: string }, runId: string, enabled: boolean, headless: boolean }): { code: PreviewResultCode; server?: PreviewServer }`
  - `previewHint(code, ctx): string`: the exact hint table in the spec's "Every result carries a recovery hint"; the `port_held` hint names the other task by title only.
  - `RunManager.registerPreviewServer(runId, request): Promise<PreviewServeResult>`: validates, probes once for `answeredAtRegistration`, writes `previewServers` (replace by port), appends `preview.server-registered`.
  - `RunManagerDeps.preview?: PreviewHost` and `cezarPort?: () => number | undefined`; absent `preview` means headless.
- `provisionCiSession` passes the preview callback on every start, Continue and recovered launch (the single construction path for the capability; no second site).

- [ ] **Step 1: Write failing tests**: one `registration.test.ts` case per code: `cwd: '../x'` → `cwd_outside_worktree`; `port` equal to `cezarPort` → `cezar_port`; owner from another run → `port_held` with hint containing `Do not stop the other task's server` and the title, not its path; 8 existing + new port → `too_many`; same port again → `replaced`; `enabled: false` → `preview_disabled` with hint starting `Do not retry`; `headless: true` → `headless`; no worktree → `worktree_missing`. `run-preview.test.ts`: a running run registers, `store.getRun(id).previewServers[0]` has `answeredAtRegistration: false` and the event log ends with `preview.server-registered`; after Continue the same callback still registers (the #811 class).
- [ ] **Step 2: Run** `npm test -- packages/cezar/src/preview/registration.test.ts packages/cezar/src/workflows/run-preview.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** Step 2's command; expect PASS.
- [ ] **Step 5: Commit** `feat(cezar): register preview servers on the run (#781)`

### Task 4: Dev-server supervisor

**Files:**
- Create: `packages/cezar/src/preview/dev-server.ts`, `packages/cezar/src/preview/__fixtures__/fake-dev-server.mjs` (listens on a port after an optional delay, optionally forks a child that holds the port, optionally prints N lines)
- Test: `packages/cezar/src/preview/dev-server.test.ts`

**Interfaces:**
- Produces:
  - `probePort(port: number): Promise<boolean>`: TCP connect to `127.0.0.1` then `::1`, 500 ms timeout each.
  - `class DevServer extends EventEmitter` with `constructor(opts: { server: PreviewServer; worktreePath: string; dir: string; probeMs?: number; waitMs?: number })`, `start(): void`, `keepWaiting(): void`, `stop(reason: 'user' | 'idle' | 'release'): Promise<void>`, `state: 'starting' | 'up' | 'stalled' | 'exited' | 'stopped'`, `exitCode?: number`, `attempts: number`, `logTail(lines = 4): string[]`. Emits `state` on every transition and `attempt` on every probe.
  - Pid record `<dir>/<port>.pid.json` `{ pid, pgid, startToken }` via `processStartToken` (`delegation/process-liveness.ts`); log `<dir>/<port>.log`, truncated to the last 1 MiB when it passes 5 MiB.
  - `sweepPreviewLeftovers(dataDir: string): Promise<number>`: for each pid record under `<dataDir>/preview/*/`, kill the group only when `recordedProcessLive({ pid, startToken })`; delete the record either way; returns kills.
- Spawn: `spawn(shell, ['-c', command], { cwd, detached: true, stdio: ['ignore', logFd, logFd] })` on POSIX; `shell: true` with `windowsHide` on Windows; kill with `process.kill(-pgid, 'SIGTERM')`, `SIGKILL` after 5 s.

- [ ] **Step 1: Write failing tests** (fake timers for wait/probe, real process for spawn): `starting → up` when the fixture listens after 300 ms; a fixture listening on `::1` only counts as up; `starting → stalled` after `waitMs`, `keepWaiting()` returns to `starting` and resets the window; a fixture exiting with code 1 → `exited`, `exitCode === 1`, `logTail()` returns its last lines; `stop('user')` on a fixture that forked a port-holding child leaves `probePort(port) === false` within 6 s; stdin is closed (a fixture that reads stdin gets EOF and exits); `sweepPreviewLeftovers` kills a live recorded group and skips a record whose `startToken` differs.
- [ ] **Step 2: Run** `npm test -- packages/cezar/src/preview/dev-server.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `dev-server.ts`.
- [ ] **Step 4: Run** Step 2's command; expect PASS.
- [ ] **Step 5: Commit** `feat(cezar): preview dev-server supervisor (#781)`

### Task 5: Chromium resolution, download and launch; minimal CDP client

**Files:**
- Create: `packages/cezar/src/preview/chromium.ts`, `packages/cezar/src/preview/cdp.ts`
- Test: `packages/cezar/src/preview/chromium.test.ts`, `packages/cezar/src/preview/cdp.test.ts`

**Interfaces:**
- Produces:
  - `resolveChromium(fs = realFs, env = process.env, platform = process.platform, arch = process.arch): string | undefined`: order PATH (`chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`), macOS app bundles, Playwright cache, agent-browser's Chrome for Testing cache, `<cezCache>/chromium`. `<cezCache>` is `~/.cache/cez` (the same root the skills cache uses).
  - `downloadTarget(platform, arch): { platformKey: 'linux64' | 'mac-arm64' | 'mac-x64' | 'win64' } | undefined`; `undefined` for linux-arm64 and anything else.
  - `downloadChromium(opts: { signal: AbortSignal; onProgress(received, total): void; fetchImpl?: typeof fetch }): Promise<string>`: reads `https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json`, downloads the Stable `chrome-headless-shell` zip for the target into `<cezCache>/chromium/.partial`, extracts with `unzip -q` (POSIX) or `tar -xf` (Windows), renames into place; abort removes `.partial`. Three attempts with 1 s / 4 s backoff.
  - `installCommand(platform, osRelease): string`: `sudo apt-get install -y chromium` (Debian/Ubuntu), `sudo dnf install -y chromium` (Fedora), `brew install --cask chromium` (macOS), else `''`.
  - `launchChromium(bin, profileDir, env): Promise<{ proc, port }>`: args from the prototype minus its root/env `--no-sandbox` logic; `--no-sandbox` only when `env.CEZ_PREVIEW_NO_SANDBOX === '1'`. Rejects with `ChromiumError { kind: 'sandbox' | 'timeout' | 'exited'; stderrTail: string /* last 4 KiB */ }`; `sandbox` when stderr matches `/No usable sandbox|zygote_host_impl|setuid sandbox/`.
  - `connectCdp(wsUrl): Promise<Cdp>` with `send(method, params?)`, `on(event, fn)`, `close()`, `closed: Promise<void>`; built on the `ws` package.

- [ ] **Step 1: Write failing tests**: resolution order against a fake fs (PATH beats Playwright cache beats cez cache); `downloadTarget('linux', 'arm64') === undefined`; `downloadTarget('darwin', 'arm64').platformKey === 'mac-arm64'`; download with a fake fetch reports progress, and abort removes `.partial`; a stderr fixture containing `No usable sandbox!` yields `kind: 'sandbox'`; `--no-sandbox` appears in args only with `CEZ_PREVIEW_NO_SANDBOX=1` even when running as root (stub `process.getuid` to 0); `cdp.test.ts` against an in-process `ws` server: request/response correlation, error responses reject with the method name, events dispatch.
- [ ] **Step 2: Run** `npm test -- packages/cezar/src/preview/chromium.test.ts packages/cezar/src/preview/cdp.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** Step 2's command; expect PASS.
- [ ] **Step 5: Commit** `feat(cezar): preview Chromium launcher and CDP client (#781)`

### Task 6: Preview session and host

**Files:**
- Create: `packages/cezar/src/preview/session.ts`, `packages/cezar/src/preview/host.ts`, `packages/cezar/src/preview/url.ts`
- Test: `packages/cezar/src/preview/session.test.ts`, `packages/cezar/src/preview/host.test.ts`, `packages/cezar/src/preview/url.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5; Task 1 message schemas.
- Produces:
  - `normalizePreviewUrl(input: string): string`: bare digits → `http://localhost:<n>/`; scheme-less → `http://`; only `http:`/`https:` survive, else throws `Error('only http(s)')`.
  - `class PreviewSession` (one Chromium page per run): `attach(viewer: Viewer)`, `detach(viewer)`, `handle(msg: PreviewClientMessage)`, `navigate(url)`, `close()`; port of the prototype's `INJECT`, screencast with one frame in flight and newest-wins, `reload { ignoreCache }` → `Page.reload({ ignoreCache })`, dialogs forwarded with `origin`. `Viewer = { sendFrame(buf: Buffer): void; send(msg: PreviewServerMessage): void; close(code, reason): void; userAgent: string }`.
  - `class PreviewHost` (one per server process): `open(ctx: RunContext, viewer, target)`, `run(runId, port)`, `stop(runId, port, reason)`, `keepWaiting(runId, port)`, `release(runId, opts?: { deleteProfile?: boolean })`, `portOwner(port)`, `probe(port)`, `close()`. `RunContext = { runId, title, worktreePath, dataDir, store: RunStore }`. Owns per-run `{ servers: Map<port, DevServer | 'adopted'>, session?, viewer?, idleTimers }`.
- Rules (spec "Data flow" and "Lifecycle"): `open` re-probes; answering → adopt and stream; silent → `state { stage: 'needs-approval', server }`; only `run` spawns. A second `open` from another viewer sends the first `replaced { by: userAgent }` and closes it. Server idle timer starts when the last viewer leaves and stops cezar-owned servers with reason `idle`; browser idle timer closes the session. Every DevServer transition appends `preview.server-state` (transitions only, never attempts) and is forwarded to the viewer as a `state` message with the attempt count. Chromium runs with the profile `<dataDir>/preview/<runId>/profile`; `release(runId, { deleteProfile: true })` on run deletion removes the whole `<dataDir>/preview/<runId>/`, worktree removal keeps the profile. A Chromium exit sends `browser-exited` with `serverUp`; only `retryBrowser` relaunches, at the last URL.

- [ ] **Step 1: Write failing tests**: `url.test.ts`: `'3000'` → `http://localhost:3000/`, `'javascript:alert(1)'`, `'file:///etc/passwd'`, `'chrome://settings'`, `'data:text/html,x'` throw. `session.test.ts` with a fake CDP: two frames while one is unacked → only the newest is sent after `ack`; `reload { ignoreCache: true }` calls `Page.reload` with `ignoreCache: true`; a dialog event reaches the viewer with `origin`. `host.test.ts` with fakes and fake timers: open on a silent registered port sends `needs-approval` and spawns nothing; `run` spawns; open on an answering port adopts and `stop` on it is refused; second viewer replaces the first; 15 min after the last viewer leaves, the cezar-owned server stops with `reason: 'idle'` and an adopted one keeps running; `release(runId)` stops servers and closes the session; a fake Chromium exit sends `browser-exited { serverUp: true }` and nothing relaunches until `retryBrowser`, which reopens the last URL; `release(runId, { deleteProfile: true })` removes `<dataDir>/preview/<runId>/`; event log gains one `preview.server-state` per transition and none per attempt.
- [ ] **Step 2: Run** `npm test -- packages/cezar/src/preview`; expect the new tests FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** Step 2's command; expect PASS.
- [ ] **Step 5: Commit** `feat(cezar): preview session and host lifecycle (#781)`

### Task 7: WebSocket endpoint, upgrade dispatcher and lifecycle wiring

**Files:**
- Create: `packages/cezar/src/server/upgrade-router.ts`, `packages/cezar/src/server/preview-socket.ts`, `packages/cezar/src/git-worktree-release.ts` (the one removal helper)
- Modify: `packages/cezar/src/server/ws.ts:236-260` (hub exposes `handleUpgrade(req, socket, head, verdict)` and stops listening itself), `packages/cezar/src/server/server.ts:6208` (attach the router; `close` and `shutdownForRestart` call `previewHost.close()`), the `removeWorktree` sites `packages/cezar/src/runs/retention.ts:177`, `packages/cezar/src/server/server.ts:4628`, `:4641`, `:4725`, `packages/cezar/src/server/project-context.ts` (context build runs `sweepPreviewLeftovers`, store `deleted` → `previewHost.release`), `packages/cezar/src/index.ts:779` (`ensureDataGitignore` gains `preview/`), `BACKWARD_COMPATIBILITY.md` §2 (the WebSocket path), `.ai/specs/2026-07-23-websocket-subscriptions.md` (named exception)
- Test: `packages/cezar/src/server/upgrade-router.test.ts`, `packages/cezar/src/server/preview-socket.test.ts`, `packages/cezar/src/git-worktree-release.test.ts`

**Interfaces:**
- Consumes: Task 6 `PreviewHost`; `verifyWsUpgrade` (`server.ts:6265`).
- Produces:
  - `attachUpgradeRouter(server, routes: Array<{ match(pathname: string): Record<string, string> | undefined; handle(req, socket, head, params): void }>)`: first match wins, no match → `socket.destroy()`.
  - Preview route matches `/api/v1/p/:projectId/runs/:id/preview/ws` and `/api/v1/runs/:id/preview/ws` (boot project). Rejections before the handshake: flag off → 404; `verifyWsUpgrade` false or `trusted: false` → 403; unknown project or run → 404; missing worktree → handshake, then `state { stage: 'worktree-removed' }`.
  - After the handshake: every text frame `previewClientMessageSchema.safeParse`d, failures dropped and logged once per connection; binary frames out are JPEG; ping/pong reaping like the hub.
  - `releaseThenRemoveWorktree(deps: { previewHost?: PreviewHost }, runId, ...removeWorktreeArgs)`: calls `previewHost.release(runId)` then `removeWorktree`.

- [ ] **Step 1: Write failing tests**: `upgrade-router.test.ts` over a real `http.Server`: `/api/v1/ws` still reaches the hub (existing `ws.test.ts` keeps passing), the preview path reaches its handler with params, `/api/v1/other` is destroyed. `preview-socket.test.ts`: flag off → 404; an Origin from another loopback port without `Sec-Fetch-Site` (untrusted) → 403; same-origin → 101; a malformed frame is dropped without closing the socket. `git-worktree-release.test.ts`: release runs before removal, and a grep-based test asserts no file under `packages/cezar/src` other than the helper and `git-worktree.ts` calls `removeWorktree(` directly.
- [ ] **Step 2: Run** `npm test -- packages/cezar/src/server/upgrade-router.test.ts packages/cezar/src/server/preview-socket.test.ts packages/cezar/src/git-worktree-release.test.ts packages/cezar/src/server/ws.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** and wire as listed.
- [ ] **Step 4: Run** Step 2's command plus `npm test -- versioned-surface bc-route-inventory route-parity`; expect PASS.
- [ ] **Step 5: Commit** `feat(cezar): preview WebSocket and process lifecycle wiring (#781)`

### Task 8: Cockpit preview client and thread card

**Files:**
- Create: `packages/web/src/api/preview-socket.ts`, `packages/web/src/routes/task-thread/preview/server-card.tsx`, `packages/web/src/routes/task-thread/preview/preview-state.ts`
- Modify: `packages/web/src/routes/task-thread/thread-state.ts` (reduce `preview.server-registered` and `preview.server-state` into one `preview-server` entry per port, placed at the registration event), `packages/web/src/routes/task-thread/session-transcript.tsx` (render it), `packages/web/src/routes/task-thread/run-header.tsx` (header toggle)
- Test: `packages/web/src/api/preview-socket.test.ts`, `packages/web/src/routes/task-thread/preview/server-card.test.tsx`, `packages/web/src/routes/task-thread/thread-state.test.ts`, `packages/web/src/routes/task-thread/run-header.test.tsx`

**Interfaces:**
- Consumes: Task 1 schemas; Task 7 path.
- Produces:
  - `connectPreview(scope: { projectId: string; runId: string }, handlers: { onFrame(blob: Blob): void; onMessage(m: PreviewServerMessage): void; onTransport(t: 'connecting' | 'open' | 'reconnecting' | 'blocked' | 'closed', attempt?: number): void }): { send(m: PreviewClientMessage): void; close(): void }`: own `WebSocket`, opened in local and remote mode alike (the hub's remote-mode rule does not apply); 2 failed upgrades before any frame → `blocked`, never retried; after a frame, 5 reconnects with backoff, then `closed`.
  - `ThreadPreviewServer = { kind: 'preview-server'; id: string; server: PreviewServer; state: PreviewServerState; exitCode?: number; reason?: 'user' | 'idle' }`.
  - `PreviewServerCard({ entry, inPreview, onOpen })`: label, port, command (mono, wrapping), cwd, state line, one action. Copy per state from the v1 design screen 05; "Run and open" and "Start again" show `Runs <command first word> ... in this task's worktree, on the host.` above or below the button as drawn; `answeredAtRegistration` shows a neutral dot and `was running when registered`, never "up".
  - Header toggle: visible when `capabilities.preview` and the run has a worktree; text `Preview`, `Preview :5173`, `Preview :5173 +1`; green dot only while the pane is live; click only opens the pane.

- [ ] **Step 1: Write failing tests**: socket client with a fake WebSocket and fake timers: two upgrade failures with no frame → `blocked` and no third attempt; drop after a frame → 5 reconnects then `closed`. `thread-state.test.ts`: a registration event followed by `starting` then `up` yields one entry with `state: 'up'` at the registration's position. `server-card.test.tsx`: one test per state in screen 05, asserting the action label and that the adopted card has no "up" text. `run-header.test.tsx`: toggle hidden with `capabilities.preview: false`; text for 0, 1 and 2 servers; clicking it never sends `run`.
- [ ] **Step 2: Run** `npm test -- packages/web/src/api/preview-socket.test.ts packages/web/src/routes/task-thread`; expect the new tests FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** Step 2's command; expect PASS.
- [ ] **Step 5: Commit** `feat(web): preview server card, header toggle and socket client (#781)`

### Task 9: Preview pane shell and states

**Files:**
- Create: `packages/web/src/routes/task-thread/preview/preview-pane.tsx`, `preview-toolbar.tsx`, `preview-stage.tsx`, `preview-states.tsx` (5.1 to 5.18 except the page itself), `log-tail.tsx`, `preview.css` under the same folder
- Modify: `packages/web/src/routes/task-thread/task-thread.tsx:312-330` (split layout: transcript left, pane right, draggable divider; below 1180 px the pane takes the main area with a `Session` control; on phones full screen), `packages/web/src/routes/task-thread/session-layout.css`
- Test: `packages/web/src/routes/task-thread/preview/preview-states.test.tsx`, `preview-toolbar.test.tsx`, `preview-pane.test.tsx`

**Interfaces:**
- Consumes: Task 8 `connectPreview`, `ThreadPreviewServer`.
- Produces:
  - `PreviewPane({ run, servers, onClose })` owning the socket for its lifetime (mount connects, unmount closes; an error boundary of its own).
  - `PreviewToolbar` order: back, forward, reload, server switcher (2+ servers), URL field, viewport menu (`Fit`, `390 × 844`, `820 × 1180`, `1440 × 900`; hidden on phones), stats (`<fps> fps · <KB/s> KB/s · <rtt> ms`, grey `idle` when no frame for 1 s), Experimental badge, More (`Reload without cache`, `Copy page URL`, `Stop server · <label> :<port>`, disabled with a lock and the reason on adopted servers), close. Room rule: with the switcher or the adopted label, stats shrink to their dot and the badge to its icon (`aria-label="Experimental"`, tooltip `Experimental`); the URL truncates at the edge and shows in full on focus.
  - `PreviewStates`: one component per stage of `previewServerMessageSchema.state`, copy from the v1 screens, with the spec's 5.7 delta; 5.14 shows the badge in the stage only.

- [ ] **Step 1: Write failing tests**: `preview-states.test.tsx`: each stage renders its title and exactly one primary button (5.1 `Download Chromium`, absent on linux-arm64 where only the command shows; 5.4 has no "without sandbox" control; 5.7 body contains `waiting on another service`; 5.14 has no retry control; 5.16 and 5.17 render command, cwd and `Run and open`). `preview-toolbar.test.tsx`: stats read `idle` after 1 s without frames; with two servers the badge renders icon-only with `aria-label="Experimental"`; Stop is disabled with the reason for an adopted server. `preview-pane.test.tsx`: unmount closes the socket; at 1179 px the transcript is hidden and `Session` returns to it.
- [ ] **Step 2: Run** `npm test -- packages/web/src/routes/task-thread/preview`; expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** Step 2's command; expect PASS.
- [ ] **Step 5: Commit** `feat(web): live preview pane and states (#781)`

### Task 10: Canvas rendering and input mapping

**Files:**
- Create: `packages/web/src/routes/task-thread/preview/input-map.ts`, `packages/web/src/routes/task-thread/preview/page-dialog.tsx`
- Modify: `preview-stage.tsx` from Task 9
- Test: `packages/web/src/routes/task-thread/preview/input-map.test.ts`, `page-dialog.test.tsx`

**Interfaces:**
- Produces:
  - `toPagePoint(clientX, clientY, rect: DOMRect, scale: number): { x: number; y: number }`: `((clientX - rect.left) / scale, (clientY - rect.top) / scale)`, rounded.
  - `pointerToMessages(e: PointerEvent-like, state): PreviewClientMessage[]`: mouse/pen as the prototype; touch: tap (≤ 10 px movement, ≤ 500 ms) → `mouseMoved`, `mousePressed`, `mouseReleased`; vertical or horizontal drag → `mouseWheel` with `deltaX/deltaY = -movement`; long-press and multi-touch → `[]`.
  - `keyToMessage(e: KeyboardEvent-like): PreviewClientMessage | undefined`: the prototype's mapping including editing commands (`selectAll`, `copy`, `cut`, `undo`, `redo`); Ctrl/Cmd+V returns `undefined` (the paste event sends `insertText`); `Cmd+K` returns `undefined` (stays with cezar).
  - `PageDialog({ dialog, onResult })`: origin label `<origin> says`, Esc = Cancel.
- Frames: `createImageBitmap(blob)` drawn to a canvas sized to the page viewport, CSS-scaled to fit; `ack` after each draw.

- [ ] **Step 1: Write failing tests**: `toPagePoint(100, 100, {left: 0, top: 0}, 0.83)` → `{ x: 120, y: 120 }`; a 5 px touch tap yields pressed+released at the tap point; a 60 px upward touch drag yields `mouseWheel` with `deltaY: 60`; a two-finger touch yields `[]`; `keyToMessage` for Ctrl+A carries `commands: ['selectAll']`, Ctrl+V and Cmd+K yield `undefined`; `PageDialog` labels `localhost:5173 says` and Esc calls `onResult({ accept: false })`.
- [ ] **Step 2: Run** `npm test -- packages/web/src/routes/task-thread/preview/input-map.test.ts packages/web/src/routes/task-thread/preview/page-dialog.test.tsx`; expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** Step 2's command; expect PASS.
- [ ] **Step 5: Commit** `feat(web): preview canvas input mapping (#781)`

### Task 11: Dry-run mock, cockpit e2e and package check

**Files:**
- Modify: `packages/cezar/scripts/mock-ci-tool.mjs` (generalize `probeCiTool(backend, wire, pr)` to `probeCezarTool(backend, wire, name, args)`; keep `probeCiTool` as a wrapper), `packages/cezar/scripts/mock-claude.mjs` (prompt marker `mock:preview-serve <port>` calls `cezar_preview_serve` with `{ command: 'node <fixture> <port>', port, label: 'web' }`)
- Create: `packages/web/e2e/fixtures/preview-app.mjs` (one page with a button that sets `location.hash = 'clicked'`), `packages/web/e2e/live-preview.e2e.ts`
- Modify: `packages/cezar/test/e2e/` package test (flag unset: the MCP server lists no `cezar_preview_serve`), `.ai/scripts/test-env-up.sh` only if the e2e server needs `CEZ_PREVIEW=1` (prefer a per-spec server, as `run-header-ci-wait.e2e.ts` does)
- Test: the e2e spec itself

**Interfaces:**
- Consumes: everything above; agent-browser's Chrome for Testing for both the test driver and cezar's Chromium (proves `resolveChromium`'s agent-browser cache branch).

- [ ] **Step 1: Write the e2e spec**: start a task with `mock:preview-serve <free port>`; wait for `[data-slot="preview-server-card"]` showing `registered · not started`; click `Run and open`; wait for the canvas to have a non-blank sample (`waitForValue` on a pixel read); click the fixture button's coordinates; wait for the URL field to end in `#clicked`; open More → `Stop server`; wait for the card to read `stopped`. Follow `packages/web/e2e/README.md` wait discipline (no one-shot read after an action).
- [ ] **Step 2: Run** `npm run test:e2e -- live-preview.e2e.ts`; expect FAIL before the mock marker exists, then implement the mock changes.
- [ ] **Step 3: Run** `npm run test:e2e -- live-preview.e2e.ts`; expect `TEST_E2E_STATUS=passed`.
- [ ] **Step 4: Run** `npm run build && TMPDIR=/tmp npm run test:package`; expect PASS including the new flag-off assertion.
- [ ] **Step 5: Commit** `test(e2e): live preview register, open, click and stop (#781)`

### Task 12: Final gate and manual QA

- [ ] **Step 1:** In the worktree: `npm ci`, then `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `TMPDIR=/tmp npm run test:package`, `npm run test:e2e:local`. Record the tested revision and each outcome in the handoff. (Run the unit gate and the e2e boot sequentially, never in parallel.)
- [ ] **Step 2: Manual QA** (record in the PR): through Traefik + Authelia, open, click and type in a preview, then let the Authelia session expire and confirm the pane shows 5.11 then a clean reconnect after login; on the ubuntu-vps behind Basic Auth, open the pane in Chrome, Safari and Firefox and record which show the page and which show 5.14 without a prompt loop; one session at 390 px wide confirming tap and swipe.
- [ ] **Step 3: Experience criteria check** against #781: every state in screens 09 to 26 matches its primary action; light and dark themes; 44 px targets at 390 px.
