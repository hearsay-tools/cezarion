# Remote access — macOS + ngrok

Expose a Squawk cockpit running on your **Mac** to the internet through an
[ngrok](https://ngrok.com) tunnel — no ports to open, no TLS to manage.

**How it's wired:** Squawk runs locally on the Mac. **ngrok** is the public
front (in place of nginx+certbot): it provides the public HTTPS URL, and its
built-in `--basic-auth` is the identity gate (the htpasswd equivalent). A
**launchd** agent keeps the tunnel up and restarts it on login (the systemd
equivalent).

```
  internet ──HTTPS──► ngrok tunnel ──►  Squawk (localhost:4321)
                      --basic-auth              launchd agent
```

---

## Prerequisites

- macOS with [Homebrew](https://brew.sh).
- An [ngrok account](https://dashboard.ngrok.com) and its **authtoken**.
- A **reserved domain** on ngrok (recommended, so the URL is stable) — optional;
  without one you get an ephemeral URL.
- At least one logged-in agent CLI — `claude`, `codex`, or OpenCode (experimental).

---

## Install

```bash
npx hsq server-install --platform macosx-ngrok
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects the agent CLIs / `gh` / `git`; offers to `brew install` the missing ones. |
| **ngrok tunnel** | Installs ngrok if needed, saves your **authtoken** (passed via the environment, never on a command line `ps` could read), and configures the tunnel to the cockpit port with **`--basic-auth`** (username + password) and, if provided, your **reserved domain**. The agent plist embeds those credentials, so it is written `0600`. |
| **Autostart** | Installs the cockpit and tunnel **launchd** agents (`~/Library/LaunchAgents/tools.hearsay.squawk.cockpit.plist` and `tools.hearsay.squawk.ngrok.plist`) with `RunAtLoad` + `KeepAlive`. |
| **Verify** | Confirms the ngrok basic-auth gate is active. |

Old installs retain `ai.cezar.cockpit` and `ai.cezar.ngrok` until migration.
Use `hsq server-migrate --dry-run`, then `hsq server-migrate`; see the
[migration guide](../migration.md#installed-servers).
Migration replaces only owned old agents and keeps private `*.plist.migrated`
backups for rollback. A successful rollback removes its backup. Migration,
reconfigure and rollback refuse foreign destination plists. Migration reports
foreign old agents and leaves them alone. Uninstall
and deploy use the recorded label and path, including for pre-switch installs.

The **username + password** you set become the ngrok `--basic-auth`
credentials — what you type in the browser to reach the cockpit over the public
HTTPS URL.

---

## Updating / redeploying

Reload the public tunnel with the standardized command:

```bash
npx hsq server-deploy --platform macosx-ngrok
```

`server-deploy` restarts the Squawk cockpit and ngrok launchd agents and
re-verifies the basic-auth gate. When the cockpit was installed through npx,
it also clears the cached owned package build under `~/.npm/_npx` first so the
kickstart fetches the newly published version instead of re-execing the old
one. A checkout or global-bin agent is left alone.

To change the setup itself, the installer is idempotent:

```bash
npx hsq server-install --platform macosx-ngrok --reconfigure autostart
npx hsq server-install --platform macosx-ngrok --reinstall   # redo everything
```

---

## Uninstall

```bash
npx hsq server-uninstall --platform macosx-ngrok
```

Removes the launchd plist and the tunnel config Squawk **owns**. Shared tools
(ngrok, the agent CLIs, `gh`) are *listed* for manual removal, not deleted.

---

← Back to [Remote access overview](./README.md)
