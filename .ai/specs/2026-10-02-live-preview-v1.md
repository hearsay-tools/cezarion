# Live preview v1: click through the agent's app from the cockpit

An agent builds a web app in a task's worktree and wants the owner to check it in a browser.
Today the owner has to find the port, reach the host, and keep the agent's dev server alive past
the end of its turn. v1 lets the agent register its dev server with cezar, and lets the owner
open it in a browser that runs on the host, docked next to the task, and click through it. The
agent does not drive that browser in v1.

Design settled with the owner on 2026-10-01/02 (cezar task 3e478497). Inputs: the
`live-preview-v1` design (the source for every state number below: 27 screens in
`assets/2026-10-02-live-preview-v1/`, plus an annotated PDF kept outside the repo; the `.pen` frame `Live Preview · v1 · light` is the editable source;
`live-preview-v0.1-archive` is the archive of the pre-review ideas) and the zero-dependency CDP screencast
prototype at `~/projects/cdp-screencast-proto` (server.mjs, client.html, smoke.mjs).

## Slices

| Slice | Scope |
|---|---|
| **v1 (this spec)** | Agent registers a dev server through a cezar tool; cezar owns the server process and one Chromium per task; the owner drives it in a docked pane. Experimental, behind `CEZ_PREVIEW=1`. |
| v2 | The agent drives the same Chromium (`agent-browser --cdp <url> --pin-tab`), so the owner watches what it does; recording comes from agent-browser's `record start/stop`. |
| v3 | Turn-based control: while the run is working, the agent holds the browser and the owner's input is view-only; parked, review and Needs You hand it to the owner. No mid-turn pause. |

## Decisions

| Question | Answer |
|---|---|
| Who is v1 for | The owner checking an agent's web app, mostly at the review gate, from a local cockpit or a remote one behind a cookie-based auth proxy (Traefik + Authelia). |
| Opt-in | `CEZ_PREVIEW=1`, off by default, strict activation like `CEZ_AUTOMATIONS`. Off removes the behavior, not only the UI: the tool is not listed, the tool route refuses, the WebSocket path refuses, `capabilities.preview` is `false`. The flag is removed when the feature graduates; opening the pane then stays the only opt-in. Rationale: v1 adds Chromium processes, cezar-owned dev servers and a browser WebSocket in remote mode, all of which AGENTS.md puts behind a flag. |
| Who starts the dev server | Cezar's server process. The agent only registers `{ command, port, label }`. The MCP process cannot own it: it is a stdio child of the agent CLI and dies with the session, like the agent's Bash children. |
| When the command runs | On the owner's Open click, never at registration. The card shows the exact command first. |
| Browser engine | The prototype's approach: headless Chromium, `Page.startScreencast` JPEG frames to a canvas, a whitelist of input messages. Raw CDP never leaves the server. |
| Transport | A dedicated same-origin WebSocket per task, trusted connections only. Not a bus topic (binary frames, one viewer, per-frame acks, upstream input). A named exception to "one socket per cockpit": it exists only while the pane is open. |
| Remote mode | Works behind cookie-based auth proxies. Basic Auth is a known gap in some browsers (#688 recorded a prompt loop on WebSocket reconnect); v1 caps upgrade retries and says so instead of looping. A fallback transport is a follow-up. |
| URL reach | Anything the host can reach. Same trust level as the agent's unrestricted Bash; no allow-list. |
| Sandbox | Never added automatically. `CEZ_PREVIEW_NO_SANDBOX=1` (off by default, documented) is the only way to launch Chromium with `--no-sandbox`. The prototype's automatic `--no-sandbox` for root is dropped. |
| Viewport presets | Labelled by size (`390 × 844`, `820 × 1180`, `1440 × 900`) plus Fit. Size only; no touch or user-agent emulation. |
| Chromium profile | Kept per task under the task's preview directory so logins in the app under test survive a browser restart; deleted with the task. |

## Agent tool: `cezar_preview_serve`

Listed in the existing cezar tool server next to `cezar_wait_for_ci`, so all five runners
(`specSupport.cezarTools` is honored by Claude, Codex, OpenCode, Cursor and Pi) get it through the
same injection. Listed only when `CEZ_PREVIEW=1`.

Input (zod, in `packages/contract/src/preview.ts`):

| Field | Rule |
|---|---|
| `command` | Required, 1..1024 chars, run through the platform shell in `cwd`. |
| `port` | Required integer 1..65535. Not cezar's own listening port. |
| `cwd` | Optional, relative to the worktree root, must stay inside it. Default: worktree root. |
| `label` | Optional, 1..48 chars, e.g. `vite`, `storybook`. Default: first word of `command`. |
| `path` | Optional initial path, e.g. `/members`. Default `/`. |

Description (the trigger line in the server instructions): "load when you have started, or are
about to start, a web server the user should click through." The description tells the agent to
pin the port (`vite --strictPort`, `next dev -p`) and that cezar starts the command itself when the
user opens the preview.

**Every result carries a recovery hint.** The tool returns `{ ok, code, message, hint }` as JSON
followed by the hint as a plain sentence, the same shape `cezar_wait_for_ci` uses. The hint tells
the agent what to do next in one step, and says explicitly when not to retry.

| `code` | `message` (example) | `hint` (example) |
|---|---|---|
| `registered` | Registered `:5173` (vite) for this task. | Continue your work. Cezar runs `npm run dev` in the worktree when the user approves it from the preview; a copy you already run on `:5173` is reused while it answers, and it stops when your session ends. Call again only if the command or port changes. Do not wait for the user to open it. |
| `replaced` | Replaced the registration for `:5173`. | Same as `registered`. |
| `invalid_input` | `port` must be an integer between 1 and 65535 (got "5173abc"). | Names the failing field and the rule, then a valid example call: `{ "command": "npm run dev -- --port 5173 --strictPort", "port": 5173 }`. Fix the field and call again. |
| `cwd_outside_worktree` | `cwd` resolves outside the worktree. | Pass a path relative to the worktree root, e.g. `"apps/web"`, or omit `cwd`. |
| `cezar_port` | `:4321` is cezar's own port. | Register your app's dev server port, not the cockpit's. |
| `port_held` | `:5173` is held by the dev server of task "Member management". | Start your server on a free port (e.g. `--port 5180 --strictPort`) and register that port. Do not stop the other task's server. |
| `too_many` | This task already has 8 registered servers. | Re-register an existing port to replace it instead of adding a new one. |
| `preview_disabled` | Live preview is not enabled in this cockpit. | Do not retry. Tell the user the server command and port so they can open it themselves. |
| `headless` | No cockpit is attached to this run (`cez run`). | Do not retry. Report the command and port in your final message. |
| `worktree_missing` | This task's worktree no longer exists. | Do not retry. |
| `worktree_missing` (the run never had a worktree: composer opt-out, non-Git directory) | This task runs without its own worktree, so live preview is not available. | Do not retry. Report the command and port in your final message. |
| `unavailable` | Cezar's tool server did not answer. | Retry once. If it fails again, continue without preview and report the command and port in your message. |

Hints never contain secrets, environment values or other tasks' paths; the other task appears by
its title only.

## Architecture

### Server: `packages/cezar/src/preview/`

| File | One job |
|---|---|
| `chromium.ts` | Resolve the binary (PATH, Playwright cache, agent-browser's Chrome for Testing cache, then `~/.cache/cez/chromium`), download Chrome for Testing into that cache on request, launch headless with the task profile and `--remote-debugging-port=0`, read `DevToolsActivePort`, stop. Typed failures: `not-installed`, `sandbox` (stderr tail kept), `timeout`, `exited`. |
| `cdp.ts` | Minimal CDP client over the `ws` package already in `packages/cezar` (Node's global `WebSocket` is not stable on the `>=20` engine floor). |
| `session.ts` | One preview session per task: the page, screencast with one frame in flight and newest-frame-wins, the input whitelist (resize, mouse, key, insertText, nav, back, forward, `reload { ignoreCache? }`, dialog reply), dialog forwarding, the injected cursor-shape binding and same-tab popups (from the prototype's `INJECT`), one viewer. |
| `dev-server.ts` | Supervisor for one registration: probe the port; if it answers, adopt; if it is silent, report `needs_approval` and spawn only on an explicit `run`. Spawn `command` in its own process group with `cwd`, the curated env (`buildCommandEnv`: the #427 allowlist without backend or `gh` credentials, plus `CEZ_ENV_PASSTHROUGH`) and stdin closed (`'ignore'`: nobody can answer a prompt from the cockpit, so an interactive prompt fails fast into `exited` with its log instead of hanging), log to the task's preview directory, TCP-probe until up. States `starting → up → exited`, plus `stalled`. Writes a pid record `{ pid, startToken }` and kills only what it started. |
| `manager.ts` | Map run → `{ servers, session }`. Owns every exit in the lifecycle table below, the boot sweep and shutdown. |

On disk, per task: `.ai/cezar/preview/<runId>/` with `profile/`, `<port>.log`, `<port>.pid.json`.
Added to `ensureDataGitignore`. Deleted with the run.

### Tool route

`packages/cezar/src/ci-wait/controller.ts` becomes a general cezar-tools controller (one private
Unix-socket server, one capability token per run session, one route per tool). New route
`POST /api/v1/tools/preview-serve` on that private socket, authenticated by the run's capability
token, so an agent can register only for its own run. The public API gains no route.

Every place that enumerates cezar tool names (Claude's generated allow-list entry at
`claude-cli-runner.ts:537`, the server instructions, Pi's tool admission) moves to one shared list,
so adding a tool is one edit.

### WebSocket

`/api/v1/p/:projectId/runs/:id/preview/ws` (and the boot alias without `/p/:projectId`).

- Today the hub's `upgrade` listener destroys every path that is not `/api/v1/ws`
  (`packages/cezar/src/server/ws.ts:246`). One upgrade dispatcher routes by path: the bus path to
  the hub unchanged, the preview path to the preview handler, everything else destroyed.
- The preview handler runs `verifyWsUpgrade` and requires `trusted`; an untrusted (loopback
  fallback) connection is refused before the handshake.
- Messages in both directions are zod schemas in `packages/contract/src/preview.ts`. Client to
  server: `open { target: { port } | { url } }` (never spawns anything), `stop { port }`, the input whitelist, `ack`,
  `ping`, `run { port }`. Server to client: binary JPEG frames; JSON `state`, `url`, `cursor`, `dialog`,
  `replaced`, `pong`.
- Route inventory: listed in BACKWARD_COMPATIBILITY.md §2 like `/api/v1/ws`.

### Run record and events

- `RunRecord.previewServers?: Array<{ port, command, cwd?, label, path?, registeredAt,
  answeredAtRegistration }>`, optional so old files parse. `answeredAtRegistration` is one TCP probe
  at registration. It is a historical observation, never a promise that Open runs nothing.
- Run events, dotted like the other cezar events: `preview.server-registered { server }` and
  `preview.server-state { port, state, exitCode?, reason? }`, appended on transitions only (`starting`, `up`, `stalled`, `exited`, `stopped` with
  `reason: 'user' | 'idle'`). Probe attempts are never events; the attempt count reaches the pane over
  the WebSocket only. They keep the card current while the pane is closed and the history after the task ends. Frames
  never reach the event log.

### Capabilities

`capabilities.preview: boolean` in `/api/health`, from `CEZ_PREVIEW=1`.

### Cockpit

Under the task route, each its own component:

- **Server card**: a cezar thread entry reduced from the `preview.server-registered` and
  `preview.server-state` run events (see "Decisions made while planning"). It renders where the
  registration event lands, which is right after the `cezar_preview_serve` tool call. Shows label, port, the exact command, `cwd` when set, the state, and
  one next action. "Was running when registered" when `answeredAtRegistration`; such a card shows a neutral
  state, never "up", because cezar does not watch a port it does not own. Whenever the next
  click may run the command (Run and open, Start again), the card says so above the button. Stop
  is never on the card.
- **Header toggle**: shown whenever `capabilities.preview` is on and the task has a worktree, so the
  owner can always open the pane and type a URL. Plain `Preview` with no registration,
  `Preview :5173` with one, `:5173 +1` with two (opens on the empty state to pick). The toggle
  only opens the pane on that server's current state; it never runs a command.
- **Split layout**: resizable divider; below 1180 px the pane takes the main area.
- **Pane**: toolbar (back, forward, reload, URL, server switcher when two or more servers are
  registered, viewport, live stats with an "idle" reading when no frames change, Experimental badge,
  More: Reload without cache, Copy page URL, Stop server, close) and the canvas stage with the states below. The empty state focuses the
  URL bar, expands a bare port to `localhost:<port>`, lists the task's registered servers and states
  the unsupported list once (copying out, file pickers, downloads).
- **URL field**: long URLs cut off at the edge and show in full while the field has focus. While
  the page comes from an adopted server, "Not started by cezar" sits inside the field and the
  Experimental badge shrinks to its icon; the icon keeps `aria-label` and a tooltip reading
  "Experimental", so it still counts as the marker.
- **Input**: the canvas listens to Pointer Events. Mouse and pen pointers map to mouse events as in
  the prototype. Touch pointers (a phone cockpit): a tap is a mouse click, a one-finger swipe is
  `mouseWheel` scrolling, long-press and pinch do nothing. This is about the cockpit device; the page
  still sees no touch emulation. On a phone the viewport is always Fit.
- **Page dialogs**: alert, confirm and prompt drawn over the viewport, labelled with the page's
  origin.
- Own error boundary: a pane crash never takes down the task view.

Out of the v0.1 archive for v1: the driver strip, ring colours, agent cursor, take over and hand
back, the pop-out route, a read-only second viewer, port detection.

## Data flow

1. The agent calls `cezar_preview_serve`. The MCP process posts to the private tool route; cezar
   validates, writes `previewServers`, appends `preview.server-registered`. The cockpit receives it
   over SSE; the card and the header button appear.
2. The owner clicks Open preview. The pane mounts and opens the WebSocket, then sends
   `open { target: { port } }`. The socket being open is the demand; no other open/stop route
   exists.
3. The manager probes the port again. If it answers, cezar adopts it. If it is silent, the pane
   gets `needs_approval { command, cwd }` and shows Run and open; only the owner's `run { port }`
   spawns the command. Adoption is decided here, at every Open, never from the registration
   probe: an agent's own copy dies with its session, and a stale "adopted" label must not turn
   into a silent spawn. The manager then waits for the port and ensures Chromium, streaming each
   step as a `state` message (5.6 to 5.10 and 5.16 to 5.17 render from these), navigates to
   `http://localhost:<port><path>` and starts the screencast.
4. Dev-server transitions append `preview.server-state` events.

## Lifecycle: states and what ends them

Every state has an exit that is on by default.

| Thing | States | Ends when |
|---|---|---|
| Registration | stored on the run | The run is deleted. Re-registering a port replaces it. |
| Dev server (cezar-owned) | `starting`, `up`, `stalled`, `exited` | `starting`: the port answers (→ `up`), the process exits (→ `exited`), 2 min without an answer (→ `stalled`, process left running, log shown). `up` and `stalled`: the process exits, the owner presses Stop, 15 min after the last viewer left, the worktree is removed, the run is deleted, cezar shuts down. |
| Dev server (adopted) | probed only | Never killed by cezar. A port that stops answering shows the `needs_approval` state with Run and open. |
| Chromium | `launching`, `ready`, `streaming` | 2 min after the last viewer left, Chromium exits (→ "browser exited", manual Retry only; no automatic relaunch, so a page that crashes Chromium cannot loop), the run is deleted, cezar shuts down. |
| Viewer | connected | Socket close, replaced by another tab (old tab gets `replaced`, renders 5.12), missed pings, cezar shuts down. |
| Leftovers after a crash | pid records on disk: `<port>.pid.json` per dev server, `chromium.pid.json` per task browser | Boot sweep of every registered project's data dir, once per process: kill only when the pid is alive **and** its `startToken` matches (`delegation/process-liveness.ts`), so a reused pid is never killed. A dev server's whole group goes; Chromium shares cezar's group, so only its pid. What the live host runs is spared, and a data dir another live cockpit owns is skipped (its context build sweeps it later, after taking ownership). |

Exit triggers:

- **Run deleted**: the manager subscribes to the run store's `deleted` emission.
- **Worktree removed**: removal happens at several sites (`runs/retention.ts:177`,
  `server/server.ts:4628`, `4641`, `4725`, and a destroyed owned worker's fenced removal in
  `delegation/workspace.ts`). All of them go through `git-worktree-release.ts`, which releases the
  task's preview once the removal is going ahead and before git removes the checkout
  (`releaseThenRemoveWorktree`, `releaseThenRemoveOwnedWorkspace`), so no site can be missed; a
  test scans the sources for direct calls and for any other `['worktree', 'remove'` git call.
- **Shutdown**: `close` and `shutdownForRestart` both call `manager.close()`.
- Constants: `PREVIEW_SERVER_IDLE_MS = 15 min`, `PREVIEW_BROWSER_IDLE_MS = 2 min`,
  `PREVIEW_PORT_WAIT_MS = 2 min` (probe every 2 s), `PREVIEW_MAX_SERVERS = 8` per task.

Port collisions between parallel tasks: a port held by another task's cezar-owned server is
refused at registration (`port_held`). A port answered by an unknown process at Open is adopted and
labelled as not started by cezar, so a wrong app is visible as such.

## Errors and edge states

Each is a typed `state` message; the toolbar never moves.

| Failure | State (v1 design) | Primary action |
|---|---|---|
| No Chromium | 5.1 | Download Chromium. |
| Downloading | 5.2, progress and time left | Cancel (removes the partial file). |
| Download failed | 5.3, the install command for the detected OS | Retry download, Copy diagnostics. |
| Sandbox failure | 5.4 with the last 4 KiB of stderr | Retry, Copy diagnostics, link to docs on `CEZ_PREVIEW_NO_SANDBOX=1`. |
| Chromium exited | 5.5, the server's state stated separately | Retry (manual only; restarts the browser at the same URL). |
| Server starting | 5.6, attempt count, the command and the log tail | Stop server. |
| Server stalled | 5.7 after 2 min, log tail | Keep waiting (resets the 2 min), Stop server. |
| Server exited | 5.8, exit code and log tail | Start again (reruns the recorded command, says so). |
| Stopped after idle | 5.9, last URL kept | Start again; reopens the last URL. A user Stop lands on 5.8's Start again. |
| First open | 5.10 steps: browser, page, first frame | none |
| Socket dropped after a frame | 5.11, last frame dimmed | 5 reconnects with backoff, then Reconnect. |
| Another tab took it | 5.12 | Use it here, Close preview. |
| Page dialog | 5.13 | The page's own buttons; Esc means Cancel. |
| Upgrade never succeeded | 5.14, "The proxy in front of cezar didn't let the preview's WebSocket through." (cezar cannot tell Basic Auth from a proxy that drops `Upgrade`; the copy names Basic Auth only as the known case) | Close preview. Stops after 2 attempts, no loop (the #688 failure mode). |
| Worktree removed | 5.15 | Close preview. The card stays in history, disabled. |
| Registered, not running | 5.16 `needs_approval`: command, `cwd`, what runs where | Run and open. Reached from the card, the header toggle, the server switcher and the empty state's Review. |
| Adopted port silent at Open | 5.17 `needs_approval`, same block | Run and open. |
| Using an adopted server | 5.18, "Not started by cezar" in the URL field | Stop server disabled with the reason. |
| Typed URL fails | Chromium's error page inside the frame | none |
| Invalid client message | Dropped, logged once per connection | none |

## Testing

- **Unit (vitest, no browser, no server)**: binary resolution against a fake filesystem;
  `DevToolsActivePort` parsing; frame backpressure against a fake CDP; the input whitelist through
  the contract schemas; the supervisor with a small Node script as the dev server; one test per row
  of the lifecycle table with fake timers; boot sweep pid reuse; port collision and adoption; Open on a registration that answered at
  registration but is silent now yields `needs_approval` and spawns nothing until `run`; touch
  tap and swipe mapping; every
  tool result code including its hint; the upgrade dispatcher (bus path unchanged, preview path
  routed, unknown destroyed, untrusted refused); flag off removes tool, tool route, WebSocket and
  capability.
- **API guards**: contract parity, typed bodies, route inventory, versioned surface, and the
  BACKWARD_COMPATIBILITY.md entry.
- **Runner parity** (AGENTS.md, `AGENT_PROTOCOL.md` §7): extend the `cezarTools` cell in
  `harness-parity.test.ts` so every `RUNNER_IDS` runner, through its own native mock wire, lists
  `cezar_preview_serve` with the flag on and not with it off. Prove it fails without the change.
- **Cockpit e2e**: the dry-run mock agent gets a scripted `cezar_preview_serve` call. One spec:
  card appears, Open yields a non-blank frame, a click changes the page, Stop ends the server.
  Chrome for Testing is already provisioned through agent-browser, which also exercises the
  binary lookup.
- **Package**: the tarball contains `dist/preview/`; with the flag unset no tool is listed.
- **Manual, recorded in the PR**: one session through Traefik + Authelia including session expiry;
  the ubuntu-vps Basic Auth setup in Chrome, Safari and Firefox.

## Decisions made while planning

Settled while writing the implementation plan. They refine the sections above; where a section
above still reads differently, this one wins.

- **The server card is a cezar thread entry, not the tool-call row.** Five runners name MCP tool
  calls five ways, so there is no one row to hang a renderer on. `thread-state.ts` already reduces
  cezar run events (`webhook.failed`) into entries. Registration appends
  `preview.server-registered`; state changes append `preview.server-state`. The card renders where
  the registration event lands, right after the tool call.
- **Event names follow the dotted convention**: `preview.server-registered { server }` and
  `preview.server-state { port, state, exitCode?, reason? }`.
- **Chrome for Testing publishes no linux-arm64 build.** On that platform 5.1 shows only the OS
  install command and no Download button (`canDownload: false`).
- **One `PreviewHost` per server process**, not per project. Ports are host-global, so `port_held`
  must see every project's servers.

## Design deltas

The v1 design is final. Where it and this spec disagree, the spec wins:

- **5.7 Server stalled.** The drawn example (a `predev` script prompting for a migration name) cannot
  stall: dev servers get no stdin, so a prompt fails fast into 5.8 Exited. Build 5.7 with a process
  that is alive but waiting on something outside it (e.g. `wait-on tcp:5432`), and body copy "It may
  be waiting on another service, or listening somewhere else." instead of "waiting for input".
- **Keyboard exit from the page.** While the page has focus every key goes to it, Tab and Escape
  included, so a form inside it works. Shift+Escape is never sent: it moves focus to the address
  field (WCAG 2.1.2), and the input layer's `aria-description` says so. Ctrl/Cmd+K still opens the
  command palette.

## Env contract

`.env.example` and the README env table gain `CEZ_PREVIEW` and `CEZ_PREVIEW_NO_SANDBOX` in the same
commit that reads them.

## Follow-up issues

1. **Command execution hardening.** `cezar_preview_serve` runs a model-supplied command as the
   owner's user, outside the agent's sandbox (Codex workspace-write, Claude permission modes). v1
   gates execution on the owner's click with the command shown; review whether that is enough,
   e.g. command allow-listing, showing a diff of the command on re-registration, or matching the
   runner's sandbox.
2. **Transport behind Basic Auth.** Frames over SSE plus input over POST, measured against a real
   proxy.
3. **v2**: agent drives the task's Chromium through a cezar CDP proxy; recording.
4. **v3**: turn-based control.

## Out of scope

Agent driving the browser, agent cursor, driver strip, take over and hand back, pop-out route,
second viewer, listening-port detection, touch and user-agent emulation, clipboard copy out, file
pickers, downloads, audio.
