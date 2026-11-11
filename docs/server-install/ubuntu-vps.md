# Remote access — Ubuntu / Debian VPS

Paths `<config>`, `<state>`, `<data>` and `<cache>` refer to the
[resolved home roots](../migration.md#home-directories).


Host the Squawk cockpit on a bare Ubuntu/Debian server, reachable over the
internet, behind a login and (optionally) HTTPS.

**How it's wired:** Squawk itself stays **loopback-bound** (`127.0.0.1:4321`,
`HSQ_REMOTE=1` or `CEZ_REMOTE=1`). Either flag enables remote mode, even if the
other is `0`. **nginx** is the only public surface — it terminates TLS,
challenges every request with HTTP Basic-Auth, and proxies to Squawk. A systemd
service keeps Squawk running and restarts it on boot.

```
  internet ──HTTPS──► nginx (:443)  ──proxy──►  Squawk (127.0.0.1:4321)
                      basic-auth + Let's Encrypt         systemd service
```

The wizard never escalates silently: **every privileged command is printed**,
and you choose to run it via `sudo` or paste it into a root shell yourself. Each
command is verified before the installer moves on.

---

## Prerequisites

- Ubuntu/Debian VPS with `apt`, reachable over SSH.
- A **normal, sudo-capable user** (the wizard refuses to run as root).
- At least one logged-in agent CLI on that user — `claude`, `codex`, or
  OpenCode (experimental). (The installer can install `gh` and the npm-based CLIs for you.)
- For HTTPS: a domain with a DNS `A`/`AAAA` record pointing at the box.
- **Ports 80/443 free.** If another reverse proxy already owns them (Dokploy,
  Coolify, Caddy…), don't run the default install — see
  [The box already has a reverse proxy](#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy).

> Tools installed in `~/.local/bin` or via nvm are found automatically — the
> installer merges your **login-shell PATH** before probing, so `claude`/`gh`
> are detected even when launched non-interactively.

---

## Install

From a published release:

```bash
npx -p @hearsay-tools/squawk hsq server-install --platform ubuntu-vps
```

Or from a git checkout on the box:

```bash
git clone https://github.com/hearsay-tools/cezarion.git
cd cezarion
npx --yes --package=pnpm@12.11.2 pnpm install --frozen-lockfile
npm run build
node packages/cezar/dist/index.js server-install --platform ubuntu-vps
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects `claude` / `codex` / `opencode` / `gh` / `git`; offers to install the missing ones. At least one agent CLI is required. |
| **Reverse proxy** | Installs **nginx**, writes an `auth_basic` + SSE-safe proxy vhost, creates the **htpasswd** identity file, and — if `ufw` is active — allows `Nginx Full` (ports 80/443). |
| **Domain + SSL** *(optional)* | Points the vhost's `server_name` at your domain, then runs `certbot --nginx` for a Let's Encrypt certificate with auto-redirect. Skippable — you can add it later. |
| **Service** | Installs a **systemd** unit (rootless `--user` + linger where possible, else a system unit), **starts Squawk now**, enables it on boot, and waits for it to answer on the loopback port. |
| **Verify** | Confirms an anonymous request is challenged (401) **and** that an authenticated request actually reaches Squawk (2xx/3xx) — a real end-to-end check, not just "nginx is up". |

### Setting the cockpit login

During the reverse-proxy step you pick the **username** (defaults to your OS
user) and a **password** — either type your own or let the installer **generate
a strong one** (shown once, so save it). This is the HTTP Basic-Auth credential
you enter in the browser over HTTPS. Squawk stores only a hash.

### The privileged-command prompt

For each root action you're asked:

- **"I'll run it myself as root"** (default) — the installer prints the exact
  command; you paste it into a root shell, then confirm. File writes show the
  **decoded** file content first, so nothing is hidden inside base64.
- **"Run it now via sudo"** — the installer runs it for you and streams output.

Your choice is remembered for the rest of the run.

---

## The box already has a reverse proxy (Dokploy, Coolify, Caddy…)

The default install above assumes Squawk owns the HTTP front. If something else
already serves **:80/:443** — Dokploy/Coolify (which run **Traefik** in Docker),
a hand-rolled nginx, Caddy — installing Squawk's nginx would fight it for those
ports. Use `--external-proxy`:

```bash
npx -p @hearsay-tools/squawk hsq server-install --platform ubuntu-vps \
  --external-proxy --domain squawk.example.com --bind-host 172.17.0.1
```

That installs **the service only** — no nginx, no certbot. Steps run:
`deps → autostart → identity`. Your proxy terminates TLS and enforces auth.

```
internet ──HTTPS──► your proxy (Traefik/Caddy/nginx) ──► Squawk (172.17.0.1:4321)
                    TLS + auth are YOURS to configure          systemd service
```

> ⚠️ **Squawk has no built-in authentication.** In the default install nginx's
> basic-auth is that gate; with `--external-proxy` there is none, and anyone who
> can reach the bound host:port can run agents on your box. Put auth on the proxy
> and keep the port off the public internet (ufw / cloud firewall).

### Which `--bind-host`?

| Your proxy runs… | `--bind-host` | Why |
|---|---|---|
| **in a container** (Dokploy/Coolify → Traefik) | `172.17.0.1` (docker bridge) | a container cannot dial the host's `127.0.0.1` |
| **on the host** (nginx, Caddy, HAProxy) | omit (defaults to `127.0.0.1`) | loopback is reachable and stays private |

Check your bridge address with `ip -brief addr show docker0`.

### Wiring it to Dokploy / Traefik

Traefik needs a route to a **host** address, so use a file-provider config
(the installer prints this snippet, filled in, at the end of the run):

```yaml
http:
  routers:
    squawk:
      rule: "Host(`squawk.example.com`)"
      entryPoints: [websecure]
      middlewares: [squawk-auth]
      service: squawk
      tls: { certResolver: letsencrypt }
  services:
    squawk:
      loadBalancer:
        servers: [{ url: "http://172.17.0.1:4321" }]
  middlewares:
    squawk-auth:
      basicAuth:
        users: ["me:$$apr1$$...."]   # htpasswd -nb me 'pass' — double every $
```

`server-deploy` and `server-uninstall` work the same in this mode (uninstall
only removes the service — it never touches the proxy it doesn't own).

---

## Updating / redeploying a new version

Once a new Squawk is available (a fresh local build, or a newly published
`@hearsay-tools/squawk`), reload the running service with one standardized command:

```bash
npx -p @hearsay-tools/squawk hsq server-deploy --platform ubuntu-vps
#   from a checkout:  node packages/cezar/dist/index.js server-deploy --platform ubuntu-vps
#   npm script:       npm run server-deploy -- --platform ubuntu-vps
```

`server-deploy` reloads systemd, **restarts the Squawk service**, checks that the
unit is active and its start timestamp advanced, waits for Squawk to answer, and
re-runs the same authenticated end-to-end check as install. A failed restart
stops the deploy even if the old cockpit still answers. The error names the
unit and includes up to 30 recent journal lines. A green deploy means the
service restarted and the cockpit is serving the new version.

- **From a checkout** the service runs `<node> <repo>/packages/cezar/dist/index.js` — so build
  first, then deploy: `git pull && npm run build && npx -p @hearsay-tools/squawk hsq server-deploy --platform ubuntu-vps`.
- **Via npx** the service runs `npx --yes -p @hearsay-tools/squawk hsq`. npx caches the resolved
  package under `~/.npm/_npx` and reuses it on restart, so `server-deploy` first
  **clears that cached owned package build** and then restarts — the next launch
  re-resolves the latest published version. (Before this, a restart silently
  kept running the cached version — see open-mercato/cezar#696.) `server-deploy` alone is enough.

The installer is also **idempotent** if you need to change the setup itself:

- `--reconfigure <ids>` — force specific steps (`deps,nginx-proxy,ssl,autostart,identity`).
- `--reinstall` — force **every** step (rewrites the unit, htpasswd, vhost…).
- `--reconfigure ssl` — add HTTPS to an existing HTTP-only install (needs a domain).

> Use `--reconfigure autostart` (not just `server-deploy`) when the **unit file
> itself** changed — e.g. after upgrading the installer — since a restart alone
> won't rewrite it.

---

## Hosting several cockpits on one box (multiple domains)

One VPS can run **several independent Squawk cockpits**, one per domain. Each
instance gets its **own** loopback port, nginx site, htpasswd, systemd service,
and state file — they share only nginx and certbot, which route by `Host`
header. Pass `--domain` to select or create an instance:

```bash
# first cockpit — the default instance (loopback :4321, ~/.local/state/hearsay-squawk/server.json)
npx -p @hearsay-tools/squawk hsq server-install --platform ubuntu-vps

# a SECOND, fully independent cockpit for another domain
npx -p @hearsay-tools/squawk hsq server-install --platform ubuntu-vps --domain shop.example.com
```

Because instances are **keyed by domain**, running `server-install` again with a
**new** `--domain` never resumes or overwrites an existing install — it stands
up a fresh instance. Run it again with the **same** `--domain` to resume or
reconfigure that instance.

What differs per instance:

| Instance | State file | nginx site | htpasswd | systemd unit | Loopback port |
|----------|-----------|-----------|----------|--------------|---------------|
| default (no `--domain`) | `<state>/server.json` | `…/sites-available/hearsay-squawk` | `/etc/hearsay-squawk/htpasswd` | `hearsay-squawk.service` | `4321` |
| `--domain shop.example.com` | `<state>/server-instances/shop-example-com.json` | `…/hearsay-squawk-shop-example-com` | `/etc/hearsay-squawk/htpasswd-shop-example-com` | `hearsay-squawk-shop-example-com.service` | auto (next free, e.g. `4322`) |

- **Port** — a new instance auto-picks the next free loopback port (`4321`,
  `4322`, …). Override with `--port <n>`. Each cockpit still serves loopback-only;
  nginx is the single public surface for all of them.
- **Login** — each instance has its own htpasswd, so every cockpit can have a
  different username/password.
- **Deploy / uninstall** — pass the same `--domain` to target that instance:

  ```bash
  npx -p @hearsay-tools/squawk hsq server-deploy    --platform ubuntu-vps --domain shop.example.com
  npx -p @hearsay-tools/squawk hsq server-uninstall --platform ubuntu-vps --domain shop.example.com
  ```

  A named-instance uninstall removes only that instance's owned artifacts and
  deletes its state file; the other cockpits and the shared nginx/certbot are
  left running. (Uninstalling the **default** instance does not remove a shared
  nginx that a named instance still needs — it lists it for manual removal.)

> Interactive installs help here too: if a cockpit already exists and you run
> `server-install` with no `--domain`, the wizard asks whether you want to set up
> a **second instance for a new domain** or manage the existing one — so the
> common "it just asks me to reinstall" case now has an obvious path forward.

---

## Uninstall

```bash
node packages/cezar/dist/index.js server-uninstall --platform ubuntu-vps
```

Removes what Squawk **owns**: the nginx vhost, htpasswd, systemd unit, and boot
linger (when this install enabled it); the distro's default nginx site is
re-enabled if the install disabled it. Shared tools it merely *lists* for you
to remove by hand (agent CLIs, `gh`, and — when this install added them —
`nginx` and `certbot` packages, plus the TLS certificate: pulling a cert can
break other vhosts).

---

## Moving an old installation

The names above describe new installs. Old installs keep their recorded names
until migration. New installs use `hearsay-squawk[-<slug>].service`, the nginx site
`hearsay-squawk[-<slug>]` and `/etc/hearsay-squawk/htpasswd[-<slug>]`.
Uninstall and deploy act on the names an install recorded, so an install made
before the switch keeps working.

`hsq server-migrate [--dry-run]` exists only with the switch on. It moves every
install recorded in one home as one group: it stops them all, stages the new
home, copies each unit and starts it on the same port. For an install that owns
its nginx site, it copies the site file with only its name and
`auth_basic_user_file` changed (TLS listeners, certificates, redirects and your
edits stay), and copies the htpasswd (the old file stays). The health check requests the
install's public URL, over HTTPS when the site has TLS, on the address the site
listens on (`curl --resolve`, so SNI and Host carry the public name), with a
temporary random probe login in the new htpasswd. An `--external-proxy` install moves only its
unit, and its check stays at the bind address. The group commits only after
every instance passes. Any failure stops the group, restores the old units and
sites and renames the new home's `install.json` to `install.json.failed`, so the
next run starts again from the untouched legacy home. A unit or site that cannot
be restored leaves its instance stopped and the rollback journal in place: fix
the reported error and re-run `hsq server-migrate`. A restored service that fails
its start check is reported as a warning. After success, old unit
files stay as `*.migrated`. `--dry-run` prints that plan and changes nothing,
not even the legacy home: the stop, every unit, site, file and `Environment=`
line it would change (it shows only the legacy source `CEZ_HOME` value and
redacts other environment values), each health check, the group, the pending
marker and the rollback. See [migration and rollback](../migration.md#installed-servers).

Until `server-migrate` succeeds, the server and every other command keep using
the old home `~/.cezar` (or `CEZ_HOME`) and print one notice to run
`hsq server-migrate`. They never migrate a home that records a server install with group migration support.
Both Ubuntu and macOS + ngrok installs have that support; a desktop install keeps its boot
migration.

---

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `502 Bad Gateway` | Squawk isn't running. `systemctl status hearsay-squawk` / `journalctl -u hearsay-squawk -n 50`. |
| `status=203/EXEC — Unable to locate executable` | An old unit with a bare `ExecStart`. Re-run `--reconfigure autostart`; the unit now uses an absolute `<node> <entry>`. |
| "no gh / claude installed" but you have them | Launched from a non-login shell without `~/.local/bin`/nvm on PATH. The current installer merges your login-shell PATH; update and re-run. |
| certbot "verification failed" but it succeeded | Fixed — verification now reads the world-readable nginx vhost, not root-only `/etc/letsencrypt/live`. |
| Cockpit unreachable, nginx fine | Ports 80/443 blocked. Check `ufw status` **and** any cloud firewall (Hetzner/AWS security groups). |
| nginx won't start: `Address already in use` | Another proxy (Dokploy/Coolify → Traefik, Caddy) owns :80/:443. Re-run with `--external-proxy` (see above). `sudo ss -ltnp \| grep -E ':80\|:443'` shows who holds them. |
| `run server-install as a normal sudo-capable user, not root` | You're `root`. `adduser squawk && usermod -aG sudo squawk`, `su - squawk`, log your agent CLI in **as that user**, then re-run. |
| External-proxy install: proxy returns 502 | Traefik runs in a container and can't reach `127.0.0.1`. Reinstall with `--bind-host 172.17.0.1` (or your `docker0` address). |
| Cockpit stuck on an old version after `server-deploy` | npx-based unit whose cache wasn't refreshed (fixed in open-mercato/cezar#696 — `server-deploy` now clears it). Manual: `rm -rf ~/.npm/_npx` as the service user, then `sudo systemctl restart hearsay-squawk-<instance>`. |

← Back to [Remote access overview](./README.md)
