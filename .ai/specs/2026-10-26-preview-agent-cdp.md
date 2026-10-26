# Live preview v2: the agent drives the task's preview browser

hearsay-tools/cezarion#784. Slice v2 of [live preview](2026-10-02-live-preview-v1.md#slices).
Behind `CEZ_PREVIEW=1`, as v1.

The agent drives the same Chromium the owner's pane shows. The owner watches the agent's clicks
and navigation live, and `agent-browser record` saves a WebM of that browser. Chromium's own debug
port does not exist: the agent reaches the browser only through a cezar proxy.

## Decisions

1. **No debug port.** Chromium starts with `--remote-debugging-pipe`. Commands go in on fd 3,
   replies come out on fd 4, each NUL-terminated (`cdpOverPipe` in `preview/cdp.ts`). Readiness
   is the first reply to `Browser.getVersion`; the 30 s deadline and the single timeout retry of
   hearsay-tools/cezarion#1474 stay. Nothing listens on TCP, so no local process can reach the
   browser except through cezar.
2. **One proxy route.** `GET /api/v1/preview/cdp/:token` is a WebSocket, workspace-level, behind
   `CEZ_PREVIEW=1` (404 when off). It is refused with 403 before the handshake for any `Origin`
   header, a `Host` that is neither loopback nor the cockpit's bound origin host, or a token no
   live session holds. A refusal from the host after the handshake closes with 1008 and the
   reason. Code: `server/preview-cdp-socket.ts`, built with the pane socket in
   `server/preview-sockets.ts`.
3. **One browser session per agent socket.** Each socket gets its own
   `Target.attachToBrowserTarget` session (`AgentCdpLink`, `preview/cdp-proxy.ts`). A command
   without `sessionId` goes to that session; a command naming a session passes only when this
   link opened it. Ids are remapped by the connection; replies and events keep wire order.
   Refused: `Browser.close`, `Browser.crash`, `Browser.crashGpuProcess`, `Target.closeTarget` or
   `Page.close` on the page the pane streams, and detaching a session the link does not own.
4. **The address is a session capability.** `CEZ_PREVIEW_CDP_URL=ws://<cockpit origin
   host>/api/v1/preview/cdp/<64 hex>` joins the session environment of every runner
   (`previewCdpSession`, `preview/agent-address.ts`). The grant is chained into the cezar tool
   capability's `revoke`, so every site that ends the tools also closes the agent's sockets. An
   inherited value is stripped (`core/agent-env.ts`). No grant under `cez run` (no cockpit
   origin) or without a worktree. Harness row R125 pins the variable on every runner's native
   process, on and off.
5. **Agents are browser demand.** An agent connection launches Chromium when none runs. While any
   agent is connected, no browser or server idle timer runs. A failed browser refuses agents and
   is not relaunched until the owner retries from the pane.
6. **The agent's page is a picker entry** (owner amendment to the plan). The run event
   `preview.agent-browser { state: connected | disconnected }` is appended on the first
   connection and the last close. The cockpit lists "Agent's page" beside the registered servers
   and opens it directly when it is the only entry. Opening it never navigates. With no agent
   connected the pane shows `agent-idle`.
7. **The pane follows the agent's page.** `agent-browser --pin-tab` opens a fresh tab
   (`Target.createTarget`) instead of the page cezar streams. The link reports each page target
   the agent creates, attaches to or activates; while the pane shows the agent's page, the host
   opens a session of its own on that target and streams it. Opening a server or a URL returns the
   pane to cezar's page and leaves the agent's tab alone. When the agent closes its tab, the pane
   falls back to cezar's page.
8. **Recording is agent-browser's.** `record start/stop` takes screenshots over CDP and encodes
   them with ffmpeg, so ffmpeg must be on the agent's `PATH`. cezar does not record.

## Transitions out

The pane's agent mode and the agent connection state. No run state is added.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| Agent connected | Agent socket closes | The agent process, or its exit | Link closes; the last close appends `disconnected`, and with no pane open the idle timers start |
| Agent connected | Session tools revoked | Turn end, cancel, finalize, recovery: every `revokeCiTools` site | Sockets close with 1008; `disconnected` appended |
| Agent connected | Chromium exits | The browser process | Sockets close with 1011; the next agent is refused until the owner retries |
| Agent connected | Preview released | Run deletion, worktree reclaim, cockpit close | Sockets close with 1001; browser closes |
| Agent connected | Socket stops answering pings | Heartbeat, 30 s | Socket terminated; same as a close |
| Agent connected | cezar is killed | The next boot's `armPreview` reads the `<dataDir>/preview/<runId>/agent-connected` marker | `disconnected` appended, marker removed, before the CDP route can accept an agent |
| Pane on agent's page | Owner opens a server or URL | The owner | Pane streams cezar's page; the agent's tab stays |
| Pane on agent's page | Agent closes the followed tab | The agent | Pane streams cezar's page |
| Pane on agent's page | Last agent leaves | As above | Pane keeps the last page; reopening shows `agent-idle` |

## Evidence

- Real Chromium through the proxy: `preview/agent-cdp-chromium.test.ts` (navigate, frames, a
  refused `Browser.close`, revoke closes with 1008).
- agent-browser 0.36 against a cockpit-shaped server (`.ai/qa/784/agent-browser-check.ts`, kept
  out of the repo): the pane saw the agent's navigation and click, `record` saved a 9,740-byte
  WebM with ffmpeg on `PATH`, and Chromium had no TCP listener.
- A pipe page can refuse the first `Page.startScreencast` with "Not attached to an active page".
  The session now starts the stream again at the next page activity (`session.test.ts`, red
  without the fix).
