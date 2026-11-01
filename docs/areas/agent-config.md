# Agent config files (Settings → Agent config)

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

The settings page groups files by agent, with MCP as a per-agent subsection (spec 2026-07-17-agent-config-by-agent). Its descriptor table is `packages/web/src/routes/settings/agent-descriptors.ts`.

## Read first

`packages/cezar/src/agent-config/` (`catalog.ts`, `files.ts`, `validate.ts`, `service.ts`, `seed.ts`), then `packages/cezar/src/paths.ts` and the `/api/v1/agent-config` routes in `packages/cezar/src/server/server.ts`

## Rules

Read and edit the coding agents' OWN config files (Claude/Codex/OpenCode settings, MCP, memory), raw and per-scope (spec open-mercato/cezar#404). `catalog.ts` is the ONLY place vendor knowledge about config FILES lives — paths + verbatim precedence strings; keep it accurate and dated. Its sibling `src/core/agent-profiles.ts` owns the other half: the env var that relocates each agent's whole home (spec `2026-07-29-agent-profiles`). Never re-serialize a file cezar opened (byte-exact round-trip). Files are addressed by catalog id, never a path. **Writing needs settings administration: every `PUT /api/agent-config/:id` 409s when `capabilities().settingsAdmin` is false — this closes a hooks-based RCE path, do not weaken it.** `settingsAdmin` is true on a local cockpit, and on a remote one bound to loopback only after the host operator runs `cez remote-settings enable` for its listen port (`src/remote-settings.ts`, [ADR 0055](../adr/0055-grant-remote-settings-administration-from-the-host.md)). No HTTP route may write that switch, infer it from the network, or widen it to a non-loopback bind. The same capability gates home-file reads, the user MCP listing and the `worktreeSetup` write; `localHandoff` keeps gating host application launches, agent accounts, browsing and updates. The gitignored personal layer is seeded into run worktrees (`seed.ts`, guarded by `git check-ignore`).
