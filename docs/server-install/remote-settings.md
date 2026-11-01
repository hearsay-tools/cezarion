# Remote settings administration

A remote cockpit (`CEZ_REMOTE=1`) shows **Settings → Agent config** and **Settings → Worktrees →
Prepare new worktrees** read-only. Both persist commands that run on the host: agent hooks and MCP
servers start outside the agent's tool permissions, and setup commands run before every task. The
host operator can let the people the deployment admits edit them from the browser
(hearsay-tools/cezarion#2428).

```bash
cez remote-settings enable    # allow remote edits; prints what it grants
cez remote-settings status    # the switch, and what each running cockpit does with it
cez remote-settings disable   # read-only again
```

Run these on the machine that runs Cezarion, as the user the cockpit service runs as, with the same
`CEZ_HOME` (default `~/.cezar`). The switch is the file `~/.cezar/remote-settings.json`. The cockpit
reads it on each request, so enable and disable take effect without a restart. No HTTP route writes
the file: a browser can never grant itself the permission.

## What it grants

With the switch on, every user the deployment admits can:

- read and save every Agent config file, including the files in the agent's home directory, and
  see the user MCP servers in `~/.claude.json`;
- save the project's worktree setup commands.

That is **host command execution as the cockpit's user**. Enable it only when the deployment admits
the people you would trust with a shell on this machine.

It does not grant anything else. The terminal, file manager and editor buttons stay unavailable,
and so do agent account administration, project browsing outside the projects folder and
application updates. The cockpit shows a warning above both editors while the switch is on.

## When it applies

The switch applies only to a cockpit that runs with `CEZ_REMOTE=1` and binds loopback (the
`127.0.0.1` default). A cockpit bound to any other address keeps settings read-only, because a
direct connection to its port would skip the deployment's authentication. A local cockpit edits
settings without the switch.

Cezar never infers the permission from the network: a private address, a LAN client or an
installed Tailscale grants nothing. The deployment in front of the cockpit decides who gets in.
The cockpit still rejects cross-origin browser writes, so the front must forward the browser's
`Host` header unchanged. If every save answers `403`, the front rewrote `Host`.

## Supported deployments

### Tailscale Serve, restricted to the owner

```bash
CEZ_REMOTE=1 cez serve --no-open  # or set CEZ_REMOTE=1 in the service unit
tailscale serve --bg 4321         # https://<machine>.<tailnet>.ts.net → 127.0.0.1:4321
cez remote-settings enable
```

Tailscale Serve is reachable by every device the tailnet policy lets reach this machine. Before you
enable the switch, restrict port 443 on this machine to the owner (or the chosen administrators)
in the tailnet policy file. For example, with the machine tagged `tag:cezar`:

```json
{
  "grants": [
    { "src": ["owner@example.com"], "dst": ["tag:cezar"], "ip": ["443"] }
  ]
}
```

Remove any broader rule that also reaches `tag:cezar`, such as a default allow-all. Do not use
Tailscale Funnel: it publishes the cockpit to the internet with no login.

### An authenticated HTTPS proxy on a LAN

Bind Cezar to loopback and let a proxy on the same machine terminate TLS and require a login on
every request. The [Ubuntu VPS installer](./ubuntu-vps.md) sets this up with nginx and HTTP Basic
authentication; a LAN host uses the same shape:

```
LAN browser ──HTTPS──► proxy (TLS + login) ──► cezar (127.0.0.1:4321, CEZ_REMOTE=1)
```

- Require authentication on every path, including `/api/` and WebSocket upgrades.
- Forward `Host` unchanged (nginx: `proxy_set_header Host $host;`).
- Keep the backend port off the network: the loopback bind does this, so do not set `--bind-host`
  to another address.
- Do not rely on identity headers such as `X-Forwarded-User`: Cezar does not read them, and a
  client can send its own.

The `--external-proxy` installs with `--bind-host 172.17.0.1` (a proxy in a container) do not bind
loopback, so the switch does not apply to them.

## Checking and turning it off

`cez remote-settings status` prints the switch and one line per cockpit it finds: `CEZ_URL` when
set, otherwise every cockpit answering on `127.0.0.1` ports 4321–4370. A remote cockpit that stays
read-only with the switch on binds a non-loopback address, or runs with another `CEZ_HOME`.

`cez remote-settings disable` removes the file. The next request is refused, with no restart.
