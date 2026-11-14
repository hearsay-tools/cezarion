# Backward compatibility

- Keep saved user data readable. Provide migrations when needed.
- Keep existing configuration, workflows and skills valid, or provide a conversion. For example, a `skillsRepos` entry without `enabled` stays enabled.
- Preserve documented commands and external interfaces. Explain intentional breaks and provide a migration path.
- Test these promises against old data and inputs.

The home recovery reason `legacy-change` is additive. Current cockpit readers
drop unknown reasons and keep known rows. Already shipped strict readers cannot gain
that tolerance retroactively: the server emits this reason only from the rebrand
release (v0.18.0), which includes the tolerant reader. The existing reset and
outside-write rows and actions keep their formats and behavior.

The host CLI actions `hsq backup import <file>` and `hsq backup ignore
<file>` add legacy-change recovery without changing `list` or `restore`, and
appear in backup help. Grant files remain unavailable to cockpit mutations; the host CLI uses
the existing HomeFile allowlist and shared recovery writer.

The `hsq migrate --resolve-legacy <file> restore|accept` action opens the
resolved legacy home before migration. Restore uses only the pinned recovery
version; Accept keeps the current bytes. Both use HomeStore locks and journals,
and Restore keeps its normal backups. A retry after resolution is a no-op.
Success prints one JSON object `{ "file": "<file>", "action": "restore|accept" }`
to stdout and exits 0. Invalid arguments or recovery failures print an error to
stderr and exit 1. Help exits 0. The action rejects `--dry-run` and does not
start migration; the operator runs `hsq migrate` again.

A rolled-back server migration keeps boot on the
legacy home while the target has `install.json.failed` and no committed marker.
Boot prints one warning naming `hsq server-migrate`. A successful explicit
`hsq migrate` or `hsq server-migrate` commits the target and clears this skip.
The existing server records identify completed non-dry-run installs. Desktop
boot, staged read-only health checks and saved formats stay unchanged.

Desktop identity changes are staged behind generated release metadata. An
old-identity build (the bridge) keeps its existing config, feed and artifact names.
Native HSQ environment aliases are additive and use presence-first fallback;
HOME keeps the P2 layout rules. Both generated sidecar aliases are pinned in
both identities so an inherited setting cannot override supervision. Old and
new managed npm package paths stay readable. The bridge retains source app
state and binds its private journal to the source, target and payload before
honoring a startup acknowledgement; it refuses conflicting destination data.
System-package installs keep a working old app and a manual move notice.

The project command `hsq migrate-project [--dry-run] [--repo <dir>]` is registered,
advertised and runs. A cockpit also moves each registered legacy project by itself at start (and a project added later when
it is added), opened or not, when nothing else is live and its plan has no blocker or
conflict; an older binary then stops seeing that project's earlier tasks. A project with
anything else live, or with a plan blocker or conflict, stays in place: the cockpit serves it
from both folders, logs what blocks the move and tries again at the next start. The
per-project write root follows moved state (hearsay-tools/cezarion#3150), so a moved
project's runs stay writable. Builds before the rebrand release (v0.18.0) do not know the
command (`cez migrate-project` is an unknown command, exit 1) and keep every ordinary write
under `.ai/cezar/`. Only the user runs it, offline: it refuses while a cockpit it can see serves the project or another live
process claims a task of it, and names what to stop. A task that is not archived keeps its own
items (worktree, `runs/<id>…` files, scratch directories) in `.ai/cezar/` with their stored paths,
listed in `.ai/squawk/legacy-runs.json`, until a later move after it is archived carries them; a cockpit of another home that lists the project but never opened it
is not seen, so the user stops it. An older binary checks neither the fence nor the journal
and opens `.ai/cezar/` directly: on a moved project it sees no earlier task but loses no data. Early
recovery runs at every entry: an entry that finds an unfinished
`.ai/squawk-migration.json` finishes it before it reads the project, and a journal that
cannot finish keeps the project refused with the cause. A journal that names anything
outside the project's own state, or that Git tracks, is refused unchanged before any step.
The command prints the plan text and a closing line, exits 0, and prints the `git mv`
commands for tracked files without running them. A dry run with plan blockers or conflicts
keeps that output on stdout and exits 1. Other refusals print one message to stderr
and exit 1. Its last step writes the marker `<git common dir>/cezar-moved-projects/<sha256 of the real root>.json` (new runtime state inside the Git directory, never in the work tree).
A project with that marker writes `.ai/squawk/` and reads `.ai/cezar/` as its fallback
(hearsay-tools/cezarion#3150); a second run on it changes nothing and says the project was
already moved. Builds before v0.18.0 ignore the marker and write under `.ai/cezar/`.

Automation runtime state gains optional `lastError` and `lastErrorAt`, and
`hsq automation list` gains an optional `failing` key on an item
(hearsay-tools/cezarion#3326). Older binaries keep both state keys through their
passthrough readers but do not clear them. The notice shows only from three
consecutive failures, and the next failed check replaces the error. Issue receipts now match by
node ID instead of repository and number, and pull request receipts by their event
ID without its repository prefix. Every stored receipt already carries both, so no
receipt is lost and no item launches again.

`cez job start|status` is an additive task command (hearsay-tools/cezarion#3097). Success
prints one JSON object to stdout and exits 0; a refusal or usage error prints
`{ "error": "<text>" }` to stderr and exits 1; help exits 0. Its `<name>.<run>.log`,
`<name>.<run>.exit` and `<name>.job.db` files are scratch state in `$TMPDIR` or `--dir`:
deleting them after the job ended loses only the record of that job. Do not delete them
while the job runs: without `<name>.job.db` the name is free, so a later start runs a second
copy beside the first, and without the directory the log and the exit code are lost. Squawk
removes `$TMPDIR` when the task ends, so a job that must outlive its task takes `--dir`. The `cezar_wait` description now names
this command in place of the `sh -c '( … ) & echo $!'` recipe, and the launch prompt gains a
"Long commands" part after the artifact part. A process wait on a PID
obtained another way still works. Its wake text for a PID that was already gone at
registration changed from `exited, code unknown` to `PID N was not running when this wait
was registered`; the stored outcome stays `exited`.

A project with no `.ai/cezar` path starts in
`.ai/squawk/` immediately when that destination is absent or a real directory. Preparation and CLI writes mark it in the Git common
directory before ordinary writes. An existing legacy path, even empty or holding
only tracked files, keeps the existing migration checks. A migration refusal for a running cockpit also lists live tasks
in the same message; it still exits 1 without moving state.

Fresh project writes also require an absent or real `.ai/squawk` directory. A
symlink or file keeps legacy writes and is never marked fresh. The destination
check is shared with migration planning. If a cockpit is known but its live tasks
cannot be read, migration still refuses and lists both the cockpit and the read
failure. It does not treat the failed read as an empty task list.


All CLI names add `--version` and `-v`: the package version plus a newline goes
to stdout, with exit 0 and no home access. Old-name notices go to stderr only.
Help uses the resolved versions path, and missing-cockpit hints and dry-run
banners use the new preferred names.

`hsq task start` no longer subscribes a task to the project webhook by default. A
script that relied on the old default passes `--notify`, or runs `hsq task notify <id>`
after start. `--no-notify` stays accepted and sends an explicit off. The run API, the
cockpit form and the notify flag on existing runs keep their behavior.

Single-project mode is removed (2026-11-13, hearsay-tools/squawk#2988). The owner waived
the deprecation window and chose a changelog entry over a startup warning.
`HSQ_SINGLE_PROJECT` and `CEZ_SINGLE_PROJECT` are ignored. `/api/v1/health` drops
`capabilities.singleProject`; its `projects` lists the whole registry. The registry routes
and `GET /fs/browse` no longer answer `409` for the mode. `hsq projects add`, `remove` and
`tag` work, and `hsq projects list` lists the whole registry. Background work (automations,
archive-on-merge, the preview sweep, warm-up with recovery) covers every registered project.
To limit it, set `HSQ_PROJECT_WARMUP=0` and `HSQ_AUTOMATIONS=0`, or unregister projects with
`hsq projects rm <id>`. The removal deletes no data and breaks no URL. Because every
registered project is now prepared at start, the automatic move from `.ai/cezar/` to
`.ai/squawk/` described above also runs for registered projects the mode used to hide;
an older binary then stops seeing that project's earlier tasks.

The project config key `worktreeTeardown` is optional and additive: it takes the shape of
`worktreeSetup`, and a config without it destroys workers as before. Worker destroy no
longer stops a test app it finds through `.ai/qa/test-env.json` and
`.ai/qa/test-env-lease.sqlite`; a project that relied on that lists its own stop command in
`worktreeTeardown`. Stop on an owned worker that already settled keeps its `review`, `done`
or `failed` status and the result its parent collects, instead of recording `cancelled`
(hearsay-tools/squawk#1907).
