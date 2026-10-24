# Task webhook and hand off (hearsay-tools/cezarion#589)

A bot driving `cez task` (hearsay-tools/cezarion#504) learns about status changes only by polling `wait` or holding
`log --follow`. A bot behind an HTTP endpoint needs a push, and the owner wants to start a task
in the cockpit and hand the rest to that bot with one click. Design settled with the owner on
2026-09-25 (cezar task 69e13332); mockup: `assets/2026-09-25-task-webhook-handoff.png` (layout
reference only — the cockpit keeps its own theme).

## Decisions

| Question | Answer |
|---|---|
| Where the webhook lives | The project's entry in `~/.cezar/config.json` (per user, `0600`), as `webhook: { url, token? }`. Never the repo's `.ai/cezar/config.json`, which teams commit. |
| Token on the wire | Write-only. Every project entry leaves the server through `toProjectListEntry` (`workspace/projects.ts`), which answers `webhook: { url, tokenSet }`. The registry is `.passthrough()`, so spreading a raw entry is how it would leak. |
| Opt-in | `notify?: boolean` on the run record and `POST /runs`. Absent = off. An explicit `true` on a project with no webhook is a 400 with a hint. |
| Client defaults | `cez task start` opts in when discovery saw a webhook on its project (`Cockpit.hasWebhook`, read from the `GET /projects` discovery already makes), `--notify` sends an explicit `true`, `--no-notify` sends nothing. The cockpit form sends `true` only when its "Notify webhook" toggle is on; the toggle renders only when the project has a webhook. |
| Mutability | `POST /runs/:id/notify { notify, message? }`, valid in every state. So `notify` is NOT part of the hearsay-tools/cezarion#504 idempotent-start hash. |
| Hand-off note | Goes to the webhook only, in `task.subscribed`'s `message`; never into the agent session. Both directions append a `handoff` run event so the thread shows when and why. Repeating `notify: true` with a note is "Send a note…". |
| Events | One delivery each time the run enters a state the project selected (hearsay-tools/cezarion#1356): `task.question` when it enters Needs you with a question pending, `task.status` for every other entry. The states are `deriveWebhookState` (`packages/contract/src/attention.ts`), read off `deriveAttention`: `needs-you`, `failed`, `done`, `cancelled`, `running`, `waiting-workers`, `waiting-ci`, `waiting-timer`, `waiting-other`. A queued run, a scheduled resume and a wait for capacity are in no state. The selection is `webhook.triggers` on the registry entry; absent means `needs-you`, `failed`, `done`, `cancelled`, and `[]` means none. Leaving a selected state for an unselected one sends nothing. `task.activity` is no longer sent (it had no writer since hearsay-tools/cezarion#1301). Always sent, whatever the selection: `task.subscribed` (opt-in: a run created with `notify: true`, or `POST /runs/:id/notify` turning it on, so a queued run is announced before its first transition). "Send test" posts `task.test`. |
| Delivery | `runs/webhook.ts`: one subscriber per project store on the `'run'` emission, the single choke point every status change passes through (both turn-end handlers, both `ActiveRun` construction sites, recovery, routes). Per-run in-order queue, 10 s timeout, 3 attempts with 1 s / 4 s backoff; 5xx, 408, 429 and network errors retry, other 4xx do not; redirects are refused so the token never follows one. Outcome on `run.webhook { lastDeliveredAt, lastError }`, plus a `webhook.failed` run event after the last attempt. Never changes the run's status. |
| Dry run | `CEZ_DRY_RUN=1` sends nothing and appends `webhook.dry-run` with the payload (no token in it). |

## Payload

```json
{
  "event": "task.status",
  "deliveryId": "<uuid, the same across retries>", "seq": 7,
  "projectId": "…", "runId": "…", "url": "<origin>/p/<projectId>/tasks/<runId>",
  "status": "waiting", "previousStatus": "running", "state": "needs-you", "activity": null,
  "occurredAt": "<iso>",
  "message": "<task.subscribed only>",
  "task": { "…the `cez task status` projection, with the pending question and notify…" }
}
```

`Authorization: Bearer <token>` when a token is set. The origin is the port `startServer` bound
(loopback for a wildcard bind). `state` is the state the delivery reports the run entering, and
`null` on `task.subscribed`; `previousStatus` stays the run's real previous status.

## Cockpit

- Settings → project General: "Task webhook" — URL, a token field that stays empty and says
  "Token set" once one is stored, one checkbox per state (hearsay-tools/cezarion#1356), Save,
  Send test, Clear token, Remove. Save sends `triggers` only when the selection changed.
- New task → Execution settings: "Notify webhook" toggle, off, not remembered.
- Thread header: "Hand off" opens a dialog (a bottom sheet below `sm`, CSS only) with an optional
  note; once on it becomes a "Notifying" chip whose menu names the webhook (host and path only)
  and offers "Send a note…" and "Stop notifying". The chip stays when the webhook was removed,
  so a run can still be switched off.
- Thread lines: `handoff` renders with the send glyph ("Handed off to webhook · 14:02 — note"),
  `webhook.failed` as a danger line, `webhook.dry-run` as a dim one.

## Out of scope

Per-run callback URLs, replaying deliveries after a restart (the queue is in memory), HMAC
signatures, workspace-level webhooks, per-run state selections, restyling the cockpit to the
mockup. Event filters by state shipped in hearsay-tools/cezarion#1356, per project.

## Several webhooks and agent reports (hearsay-tools/cezarion#1576)

Design approved with the owner on 2026-10-24 (cezar task 80468f89). It extends the decisions
above; where they disagree, this section wins.

| Question | Answer |
|---|---|
| Storage | The registry entry holds `webhooks: [{ id, name, description?, url, token?, tasks, triggers?, agent }]`, at most 16, names unique per project ignoring case. `id` is generated and never edited. `tasks` turns task notifications on; `triggers` keeps its meaning above. `agent` exposes the webhook to agents. |
| Upgrade | `workspace/webhooks.ts` reads a stored `webhook` key with no `webhooks` list as one webhook, `{ id: 'task-webhook', name: 'Task webhook', tasks: true, agent: false }`, so deliveries continue unchanged with no migration. The first write through the webhook routes stores `webhooks` and deletes `webhook`; an older cezar then sees no webhook (the downgrade cost, in `BACKWARD_COMPATIBILITY.md`). |
| Wire | Project entries add `webhooks?` (tokens redacted to `tokenSet`). `webhook?` stays the first webhook with `tasks` on, and the old `PATCH { webhook }` and `POST …/webhook/test` act on it. New routes: `POST /projects/:projectId/webhooks`, `PATCH`/`DELETE /projects/:projectId/webhooks/:webhookId`, `POST …/:webhookId/test`. |
| Notify and Hand off | A run with `notify` on reaches every webhook with `tasks` on, each filtered by its own `triggers`. `task.subscribed` goes to all of them. `notify: true` with no such webhook stays a 400. Choosing webhooks per run is deferred until someone needs it. |
| Delivery | One per-run dispatch queue resolves the webhooks as they are now and keeps a run's changes in order; each webhook then has its own per-run queue, so one slow or failing endpoint never delays another. `seq` counts per run and webhook. Every task payload adds `webhook: { id, name }`. |
| Failures | `webhook.failed` adds `webhookId` and `webhookName`. `run.webhook.lastError` starts with the webhook's name, with `lastErrorWebhookId`; only a later success to that webhook clears it. A failure never changes the run's status. |
| Agent interface | Project-scoped `GET /agent-webhooks` lists `{ id, name, description? }` for webhooks with `agent` on — never the URL or token. `POST /agent-webhooks/:webhook` (id, or name ignoring case) takes `{ runId?, title?, message (Markdown, ≤ 64 KiB), data? }` and sends one `agent.report`, with the task deliveries' timeout and retries, and answers the outcome. A webhook closed to agents answers the same 404 as an unknown one. A known `runId` gets a `webhook.report` thread event. |
| Agent discovery | `cez webhook list` and `cez webhook send <name> --message-file <f> [--title] [--data]`, addressed by `CEZ_COCKPIT_URL`/`CEZ_PROJECT_ID`, with `CEZ_TASK_ID` as the reporting run. When a cockpit is attached and at least one webhook is exposed, the system prompt gets a "## Project webhooks" part listing names and descriptions with the command (`webhooks/prompt.ts`, composed at both session construction sites). Otherwise the prompt is unchanged. |
| Cockpit | Settings → General → "Webhooks": an empty state with Add webhook, then one card per webhook (name, host and path, Task notifications and Agents badges), each with its own form: name, description, URL, token, task notifications with the state checkboxes, "Let agents send reports". A save error keeps the values and says how to retry. Hand off names the webhooks it reaches. |

### `agent.report` payload

```json
{
  "event": "agent.report",
  "deliveryId": "<uuid, the same across retries>",
  "occurredAt": "<iso>",
  "projectId": "…",
  "webhook": { "id": "…", "name": "Friction reports" },
  "runId": "…", "url": "<origin>/p/<projectId>/tasks/<runId>",
  "title": "<optional one line>",
  "message": "<Markdown>",
  "data": { "…any JSON object…": true },
  "task": { "…the `cez task status` projection…": true }
}
```

`runId`, `url` and `task` appear when the report names a run the project knows.

No run state is added or changed, so there is no Transitions-out table. No `CEZ_*` variable is added.
