# Backward compatibility

- Keep saved user data readable. Provide migrations when needed.
- Keep existing configuration, workflows and skills valid, or provide a conversion. For example, a `skillsRepos` entry without `enabled` stays enabled.
- Preserve documented commands and external interfaces. Explain intentional breaks and provide a migration path.
- Test these promises against old data and inputs.

The staged home recovery reason `legacy-change` is additive. Current cockpit readers
drop unknown reasons and keep known rows. Already shipped strict readers cannot gain
that tolerance retroactively: the server emits this reason only with `REBRAND_SWITCH`
enabled, in the release that includes the tolerant reader. The existing reset and
outside-write rows and actions keep their formats and behavior.

The staged host CLI actions `cez backup import <file>` and `cez backup ignore
<file>` add legacy-change recovery without changing `list` or `restore`. They
refuse while `REBRAND_SWITCH` is disabled and appear in backup help only when
enabled. Grant files remain unavailable to cockpit mutations; the host CLI uses
the existing HomeFile allowlist and shared recovery writer.

The staged `hsq migrate --resolve-legacy <file> restore|accept` action opens the
resolved legacy home before migration. Restore uses only the pinned recovery
version; Accept keeps the current bytes. Both use HomeStore locks and journals,
and Restore keeps its normal backups. A retry after resolution is a no-op.
Success prints one JSON object `{ "file": "<file>", "action": "restore|accept" }`
to stdout and exits 0. Invalid arguments or recovery failures print an error to
stderr and exit 1. Help exits 0. The action rejects `--dry-run` and does not
start migration; the operator runs `hsq migrate` again. The entire `migrate`
command and its help entry remain absent while `REBRAND_SWITCH` is disabled.

With `REBRAND_SWITCH` enabled, a rolled-back server migration keeps boot on the
legacy home while the target has `install.json.failed` and no committed marker.
Boot prints one warning naming `hsq server-migrate`. A successful explicit
`hsq migrate` or `hsq server-migrate` commits the target and clears this skip.
The existing server records identify completed non-dry-run installs. Desktop
boot, staged read-only health checks, saved formats and switch-off behavior stay
unchanged.

Desktop identity changes are staged behind generated release metadata. The
ordinary switch-off config, feed and artifacts retain their existing names.
Native HSQ environment aliases are additive and use presence-first fallback;
HOME keeps the P2 layout rules. Both generated sidecar aliases are pinned in
both identities so an inherited setting cannot override supervision. Old and
new managed npm package paths stay readable. The bridge retains source app
state and binds its private journal to the source, target and payload before
honoring a startup acknowledgement; it refuses conflicting destination data.
System-package installs keep a working old app and a manual move notice.

The staged project command `hsq migrate-project [--dry-run] [--repo <dir>]` is registered,
advertised and runs exactly when `REBRAND_SWITCH` is true. With the switch true, a cockpit
also moves an idle legacy project by itself at start or at the project's first open; with
anything else live it leaves the project in place, serves it from both folders, logs what
blocks the move and tries again at the next start. The switch must not turn on before the
per-project write root follows moved state (hearsay-tools/cezarion#3150): until then a moved
project's runs are read-only fallback runs. With the switch false, as
shipped, help and dispatch omit it (`cez migrate-project` is an unknown command, exit 1), no
route or setting exposes it, and every ordinary write stays under `.ai/cezar/`. Only the user
runs it, offline: it refuses while a cockpit serves the project or a task is live and names
what to stop. Early recovery runs in both switch states: an entry that finds an unfinished
`.ai/squawk-migration.json` finishes it before it reads the project, and a journal that
cannot finish keeps the project refused with the cause. A journal that names anything
outside the project's own state, or that Git tracks, is refused unchanged before any step.
The command prints the plan text and a closing line, exits 0, and prints the `git mv`
commands for tracked files without running them; a refusal prints one message to stderr
and exits 1.
