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
also moves each registered legacy project by itself at start (and a project added later when
it is added), opened or not, when nothing else is live and its plan has no blocker or
conflict; an older binary then stops seeing that project's earlier tasks. A project with
anything else live, or with a plan blocker or conflict, stays in place: the cockpit serves it
from both folders, logs what blocks the move and tries again at the next start. The switch must not turn on before the
per-project write root follows moved state (hearsay-tools/cezarion#3150): until then a moved
project's runs are read-only fallback runs. With the switch false, as
shipped, help and dispatch omit it (`cez migrate-project` is an unknown command, exit 1), no
route or setting exposes it, and every ordinary write stays under `.ai/cezar/`. Only the user
runs it, offline: it refuses while a cockpit it can see serves the project or a task is live,
and names what to stop; a cockpit of another home that lists the project but never opened it
is not seen, so the user stops it. An older binary checks neither the fence nor the journal
and opens `.ai/cezar/` directly: on a moved project it sees no earlier task but loses no data. Early
recovery runs in both switch states: an entry that finds an unfinished
`.ai/squawk-migration.json` finishes it before it reads the project, and a journal that
cannot finish keeps the project refused with the cause. A journal that names anything
outside the project's own state, or that Git tracks, is refused unchanged before any step.
The command prints the plan text and a closing line, exits 0, and prints the `git mv`
commands for tracked files without running them; a refusal prints one message to stderr
and exits 1. Its last step writes the marker `<git common dir>/cezar-moved-projects/<sha256 of the real root>.json` (new runtime state inside the Git directory, never in the work tree). With the switch true,
a project with that marker writes `.ai/squawk/` and reads `.ai/cezar/` as its fallback
(hearsay-tools/cezarion#3150); a second run on it changes nothing and says the project was
already moved. With the switch false the marker is ignored and writes stay under
`.ai/cezar/`.

`cez job start|status` is an additive task command (hearsay-tools/cezarion#3097). Success
prints one JSON object to stdout and exits 0; a refusal or usage error prints
`{ "error": "<text>" }` to stderr and exits 1; help exits 0. Its `<name>.<run>.log`,
`<name>.<run>.exit` and `<name>.job.db` files are scratch state in `$TMPDIR` or `--dir`:
deleting them after the job ended loses only the record of that job. Do not delete them
while the job runs: without `<name>.job.db` the name is free, so a later start runs a second
copy beside the first, and without the directory the log and the exit code are lost. Cezar
removes `$TMPDIR` when the task ends, so a job that must outlive its task takes `--dir`. The `cezar_wait` description now names
this command in place of the `sh -c '( … ) & echo $!'` recipe, and the launch prompt gains a
"Long commands" part after the artifact part. A process wait on a PID
obtained another way still works. Its wake text for a PID that was already gone at
registration changed from `exited, code unknown` to `PID N was not running when this wait
was registered`; the stored outcome stays `exited`.

With the release switch on, a project with no `.ai/cezar` path starts in
`.ai/squawk/` immediately. Preparation and CLI writes mark it in the Git common
directory before ordinary writes. An existing legacy path, even empty or holding
only tracked files, keeps the existing migration checks. Switch-off paths and help
remain unchanged. A migration refusal for a running cockpit also lists live tasks
in the same message; it still exits 1 without moving state.
