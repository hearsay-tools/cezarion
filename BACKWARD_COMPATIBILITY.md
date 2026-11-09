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

`cez job start|status` is an additive task command (hearsay-tools/cezarion#3097). Success
prints one JSON object to stdout and exits 0; a refusal or usage error prints
`{ "error": "<text>" }` to stderr and exits 1; help exits 0. Its `<name>.log`,
`<name>.exit` and `<name>.job.db` files are scratch state in `$TMPDIR` or `--dir`:
deleting them loses only the record of that job. The `cezar_wait` description now names
this command in place of the `sh -c '( … ) & echo $!'` recipe. A process wait on a PID
obtained another way still works. Its wake text for a PID that was already gone at
registration changed from `exited, code unknown` to `PID N was not running when this wait
was registered`; the stored outcome stays `exited`.
