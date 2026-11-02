# Grant remote settings administration from the host

Agent config and worktree setup persist commands the host runs: agent hooks and MCP servers start
outside the agent's tool permissions, and setup commands run before every task. A remote cockpit
(`CEZ_REMOTE=1`) therefore keeps them read-only. The host operator can grant them to the users one
cockpit admits with `cez remote-settings enable [--port <n>]`, which writes
`~/.cezar/remote-settings/<port>.json` for that cockpit's listen port (hearsay-tools/cezarion#2428).
The server reads the file for its own port on each request.

The capability is `settingsAdmin`: true on a local cockpit, or on a remote cockpit bound to loopback
while the file grants the port that cockpit listens on. It gates the Agent config listing (with the user MCP
servers), home-file reads, Agent config writes and the `worktreeSetup` write. `localHandoff` keeps
gating host application launches, agent accounts, browsing, path disclosure and updates.

## Consequences

At the default, with no file, a remote cockpit behaves as before: every guarded request 409s. With
the file, the deployment's authentication decides who can write host commands, and the operator
has granted that right to every admitted user. The cockpit shows a warning above both editors.

Only the host can turn the switch on. No HTTP route writes the file, and browser-editable project
config is not an authority for it. A private address, a LAN client or Tailscale grants nothing.
A non-loopback bind never takes the switch, because a direct connection to its port would skip
the deployment's authentication. The request-origin guard of ADR 0046 still applies, so the front
must forward `Host` unchanged.

A grant names a port, not a home, because cockpits on one host can share a home: the multi-domain
installer runs one service per domain, each with its own port and login, under one user and one
`CEZ_HOME`. A grant for one domain gives nothing to another. A port outlives an install, so
`server-uninstall` withdraws the removed cockpit's grant and a fresh `server-install` withdraws any
grant left on its port; a resumed install keeps its own.

One file per port makes every grant and withdrawal a single create, rename or remove, so two
commands at once never restore each other's withdrawn grants. The cockpit re-reads health and the
Agent config listing when a settings editor opens and after a refused save, because a remote cockpit
gets no live health push.

Reads fail closed: a missing, malformed or unreadable file grants nothing. Disable withdraws one
port's grant, or every grant, and the next request is refused.

## Considered Options

- **An env flag such as `CEZ_REMOTE_SETTINGS=1`.** Rejected: turning it on or off needs a service
  restart, and checking it needs a request to the running cockpit.
- **One file listing every grant.** Rejected: each change read and rewrote the whole list, so two
  concurrent commands could restore a withdrawn grant.
- **One grant per `CEZ_HOME`.** Rejected: it reached every cockpit sharing the home, including
  other domains of a multi-domain install whose users the operator never granted.
- **Trust private addresses or a detected Tailscale.** Rejected: neither identifies an
  administrator.
- **Built-in accounts and roles.** Out of scope; the deployment owns authentication.

Implementation: [remote-settings.ts](../../packages/cezar/src/remote-settings.ts),
[remote-settings-cli.ts](../../packages/cezar/src/remote-settings-cli.ts),
[capabilities.ts](../../packages/cezar/src/server/capabilities.ts),
[server.ts](../../packages/cezar/src/server/server.ts).

Coverage: [capabilities.test.ts](../../packages/cezar/src/server/capabilities.test.ts),
[agent-config-api.test.ts](../../packages/cezar/src/server/agent-config-api.test.ts),
[config-api.test.ts](../../packages/cezar/src/server/config-api.test.ts),
[remote-settings-cli.test.ts](../../packages/cezar/src/remote-settings-cli.test.ts).
