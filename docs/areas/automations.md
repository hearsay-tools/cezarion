# Automations (GitHub polls and schedules)

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/automations/`, then `packages/contract/src/automations.ts`, `packages/contract/src/automation-schedule.ts`, the automations family in `packages/cezar/src/server/server.ts`, `packages/web/src/routes/automations/`, and `.ai/specs/2026-10-02-scheduled-automations.md`

## Rules

Opt-in behind `CEZ_AUTOMATIONS=1`; the gate middleware answers `409` otherwise. Two kinds: `github` polls, `schedule` fires on the clock and needs no remote. A schedule fire takes the hearsay-tools/cezarion#651 store lease, reserves one receipt per occurrence (`<id>:schedule:<iso>`), launches an ordinary task, and never advances `nextRunAt` on a lost lease. At most one catch-up inside 24 h, auto-pause after 3 consecutive launch failures. `setState` is a read-modify-write against a fresh disk read. No `task.dispatch`, no default-on. Stage 2 (hearsay-tools/cezarion#774): `cez automation` (`automations/automation-cli.ts`) reaches the cockpit through `CEZ_COCKPIT_URL`/`CEZ_PROJECT_ID`, which the boot manager receives at construction (`serve` binds its listener before it recovers, so recovered runs carry it) and every other project's manager receives from `startServer` via `RunManager.setCockpitAddress`; it never starts a server or probes ports on its own. The prompt part and the built-in `create-cezarion-automation` skill share ONE gate (`CEZ_AUTOMATIONS=1` AND an address): add any new skill lookup through `RunManager.builtinSkills()` and any new session construction site through `automationsPart()`. Templates, calendars and stats are stage 3.
