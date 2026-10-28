# Native reaper regression for hearsay-tools/cezarion#954

This is a CI-only reaper/private-checkpoint integration fixture. It does not
boot RunStore, DelegationService, a daemon, or an agent. Native execution is
allowed only on the disposable GitHub Actions VM. Local checks are syntax and
pure protocol replay. The Python probe owns process creation, namespaces,
pidfds, mounts, deadlines, and teardown. The Node driver adds no supervisor.

## Cases (implementation scope, before code edits)

| Case | Independent setup | Actions | Required outcome at production defaults |
| --- | --- | --- | --- |
| Worktree closed-fd mapping | Target maps only owned/mapped through private alias; cwd outside; no owned fd | stop | Real reaper stops target; sibling lives; Python verifies exit before deleting owned root |
| Scratch closed-fd mapping | Same fixture shape, fresh root and targets | stop | Same stop-before-delete proof for scratch |
| Cwd only | Fresh target, cwd owned root, no owned maps/fds | stop | Target stops on cwd evidence alone |
| Fd only | Fresh target, one owned fd, no owned maps/cwd | stop | Target stops on fd evidence alone |
| Nested overmount | Map only owned/nested/mapped, close fd, overmount alias/nested with unrelated nested directory | observe, stop | Owned mapping remains attributable; no extra top-level mapping can satisfy the row |
| Changed root | Map owned/mapped, close fd, chroot target; retain original outer PID attribution | observe, stop | Target is detected and stops despite changed root |
| Detached alias | Fresh linked mapping; same target/root across phases | seed, detach, retain, retain in fresh Node process, target munmap, release | Seed aborts after private checkpoint write before signals; detached mapping retains root without signalling; restart keeps retention; release clears it before deletion |
| Ordinary user | Fresh target, sibling and reader share nonzero UID and no effective capabilities; private fixture owned by UID | stop | Same stop-before-delete proof; inability to inspect is a required failure, never a skip |

Every row has a same-device unrelated sibling. Shared fixture construction is
allowed; processes and resources must be fresh between rows. Only detached
phases deliberately share a target and checkpoint. Each Node invocation is a
fresh process. A worktree-shaped directory and a scratch-shaped directory test
the reaper's resource roots, not Git worktree removal or service authorization.

## Process exits

| Case | What stops it | Fixture result |
| --- | --- | --- |
| Normal stop | Production reaper stops target; Python stops pinned sibling after checks | Delete only after verified owned exits |
| Controller SIGINT/SIGKILL before child creation | Existing bootstrap parent-death check/lifeline | No new driver process exists |
| Controller interrupted after child creation | Existing lifeline exits namespace PID1, terminating namespace descendants | Retain fixture until exact handle exit/namespace teardown is verified |
| Missing/forged protocol or changed identity | Driver rejects before importing/calling reaper | No deletion authorization; Python retains on unknown |
| Driver input/output/deadline failure | Existing supervisor owns timeout and teardown | Retain; never interpret failure as empty discovery |

The existing gated lifecycle suite must also run against the production-mode
bootstrap. The driver does not replace those lifecycle checks.

## Wire contract

Invoke `node --experimental-transform-types .github/scripts/linux-reaper-regression.mjs`.
Write one JSON request followed by newline to stdin, then close stdin. The limit
is 64 KiB each for request and result. Python enforces a 15-second driver bound;
the driver bounds input at 5 seconds and the full invocation at 12 seconds.
The production reaper keeps its default 3-second timeout and work budget.

`linux-reaper-protocol.mjs` defines the request shape and validates it without
reading proc or importing production code. `fixtureRoot` is canonical, private,
mode 0700, owned by `readerUid`. `resourceRoot` is exactly its `owned` child for
worktree or `scratch` child for scratch. `execution.json` in the fixture root is
the private checkpoint. Generation and resource UUIDs stay fixed across phases.
Every row creates `resourceRoot/mapped`, `resourceRoot/nested/mapped` and
`fixtureRoot/sibling/mapped`. Node checks both owned file identities, so an extra
top-level mapping cannot satisfy the nested row. The sibling maps its own file,
closes that descriptor, and keeps cwd outside the owned root. Its device must
match the target file while its inode differs.

Python sends local PID, external PID, start token, UID, mount namespace and root
inode identity for each explicit target/sibling handle. External PID is report
attribution only: Node never uses it to read proc or send a signal. The outer
controller must derive its handles from the inherited outer proc view, never
from a namespace-local PID. Node verifies the namespace against the inherited
outer identities, self PID against the matching proc view, PID1's start token,
and each live target identity before importing the reaper.

For ordinary-user proof, Python drops groups, GID and UID for target, sibling and
reader, and sets target dumpability after the credential change when required.
The reader must have no effective capabilities. No sysctl or host policy edits.

Result fields are `version`, `case`, `action`, `resourceKind`, `status`, `code`,
`allowDelete`, `target`, `sibling`, `elapsedMs`, and `checkpointRetained`.
Process results retain `pid`, `outerPid`, `startToken`, and `alive`.
Errors add bounded `error` text. A passed `stop` permits deletion only after the
target exited; a passed `release` permits deletion after the live target released
its mapping and the checkpoint cleared. Python independently verifies pidfds and
release acknowledgement before deletion. Observation, seed and retain never
permit deletion. Any unrecognized result is a failure, with retention.

Exit 0 means the required phase passed. Exit 42 is reserved for a normal return
from the real reaper while the same target incarnation still lives, with code
`holder-survived-reap`. Other failures exit 1. Proof-base CI must require both
exit 42 and that exact code for the closed-fd mapping stop row. Namespace,
permission, import, syntax, timeout, and checkpoint failures are not regression
proof.

The driver records each real `process.kill` call and forwards it only for the
explicit target, after fresh identity checks. This audit is a last fixture guard;
the matching proc/PID namespace provides isolation. A sibling signal attempt is
a test failure. Non-stop phases require zero signal attempts. Malformed requests
and early failures can omit process/checkpoint fields; they always exit 1 and
cannot authorize deletion.

## Proposed workflow integration (parent-owned)

1. Add the driver/protocol/pure replay files to the workflow path filter. Install
   workspace dependencies with the pinned pnpm lockfile before Node imports.
2. Extend the existing Python bootstrap with a production mode: matching proc
   mount inside its disposable PID namespace; non-PID1 Node reader; explicit
   target/sibling pidfds; protocol and before-delete assertions above.
3. Run every fixed row, then the existing production-mode lifecycle checks.
4. Use a separate checkout of proof base
   `52e4b4533b689cf41b288ac0c63205bea7f26a1a`. Copy the exact candidate fixture
   scripts into it. Use the Python stop-only proof selection, since the legacy
   source cannot run the candidate observer. Run the same mapping-only stop row
   for worktree and scratch, expecting exit 42 and
   `holder-survived-reap`. Keep source files at proof base; do not rewrite source.
5. Save source commit/tree hashes, SHA256 of every fixture and imported source,
   exact argv, capability/namespace records, actual exit/result, and expected
   outcome as artifacts, including on failure. Test hashes must match between
   proof base and candidate. Do not accept selector-only observation as proof.

Native rows are **unrun** until that CI evidence exists. Service destruction is
outside this fixture: it needs its own targeted integration coverage. Synthetic
callback failures and mocked scans cannot substitute for the native rows.

Safe local commands: `node .github/scripts/linux-reaper-protocol-check.mjs`,
`node --check` on each new `.mjs` and the observer, and `git diff --check`.
The pure check imports only `linux-reaper-protocol.mjs`. It never loads the
native guard, reaper or supervisor and does not read proc or send signals.
