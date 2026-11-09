# Code review rules

Review the actual diff against its accepted scope and the behavior users depend
on. Read the relevant area rules through [AGENTS.md](AGENTS.md#task-routing).
Check current code and evidence before applying an old example or assumption.

## Review priorities (in order)

1. **Run lifecycle correctness.** Runs, steps, worktrees and sessions must preserve
   user work and reach their required outcomes.
2. **Working defaults and graceful degradation.** Keep the zero-config path and
   supported behavior when optional tools, network or configuration are absent.
3. **Saved data and interface compatibility.** Preserve existing data and documented
   interfaces under [BACKWARD_COMPATIBILITY.md](BACKWARD_COMPATIBILITY.md).
4. **Security.** Review the actual local or hosted deployment boundary, including
   access to agent processes, files and task content.
5. **Simplicity.** Challenge dependencies and abstractions the change does not need.
   Check package ownership and runtime or browser cost against the
   [package rules](docs/areas/packages.md).

## Checklist

Apply the checks relevant to the changed mechanism.

- **Scope and preserved behavior:** compare the diff with the accepted outcome.
  Check the guarantees the old mechanism provided, shipped defaults, failure paths
  and applicable case tables. Follow [Changing working behavior](#changing-working-behavior)
  and require the relevant [regression proof](docs/sdlc/regression-proof.md).
- **Types and boundaries:** preserve the changed package's compiler checks and
  narrow uncertain values. For HTTP changes, use the
  [contract and route rules](docs/areas/http-api.md): shared schemas, chained
  routes and validation middleware. Check actual inputs and outputs; do not widen
  a schema to hide a disagreement.
- **Saved state:** check old data, unknown fields, write ordering, crash recovery
  and intentional overwrite behavior. The [run-store rules](docs/areas/runs-store.md)
  require optional or defaulted new RunRecord fields and forbid treating an
  unreadable store as empty. Atomic replacement and exclusive creation serve
  different purposes; check the guarantee the write needs.
- **Security boundaries:** check Host and Origin authority, WebSocket trust,
  path containment, secret handling and process arguments. Use
  [ADR 0046](docs/adr/0046-guard-local-http-and-websocket-authority.md) for local
  and hosted HTTP security, [AGENTS.md](AGENTS.md#shared-helpers) for shell quoting,
  and the [runner rules](docs/areas/runners.md) for effective tool access. A tool
  list alone does not establish process isolation.
- **Degradation:** check expected absence and malformed optional configuration
  against the current helper's contract. The
  [git/worktree rules](docs/areas/git-worktree.md) describe its failure behavior.
- **Cockpit behavior:** use the [web UI rules](docs/areas/web-ui.md). Check affected
  user flows, themes, keyboard access, mobile layout and accessibility. Inspect
  the browser specs selected by the reader sweep.
- **Test evidence:** check that tests protect the changed behavior and exercise
  the relevant boundary. A cockpit flake fix or retry needs a failure bundle or
  local reproduction in the PR or review thread, as the
  [e2e guide](packages/web/e2e/README.md) requires. Request changes when it has
  neither. Keep durable intent in source comments and investigation evidence
  with the PR. A shrunk product budget applies only to its step and never races
  its fixture startup; review checks this because the scan cannot. Size a bound
  per step, or use a window that restarts on progress.

## Changing working behavior

Before replacing, removing or merging a timer, lock, cap, timeout, state, handler,
queue or default, name the guarantee the old mechanism was load-bearing for.
Before changing an existing test's expected outcome, name the guarantee it pinned
and explain its replacement or the authorized reason to drop it.

Diff the shipped-default path: with every new setting at its shipped default,
what does the old scenario do now? A replacement that ships off is not a replacement.
Test paths that read `this.active.get(runId)` with no live session: the absent
entry still reaches the required durable outcome and a usable next step. A
fail-open helper needs a test of empty or absent input.

A regression test must fail without the fix: require
[regression proof](docs/sdlc/regression-proof.md). Guard tests that pass both ways
may stay; say which is which.

A change to a shared name, value or default finds and updates every reader, or
states why a reader stays. Search source, browser e2e, package tests and scripts,
including embedded child scripts, mock parity/final-message cells and records
later automation runs read. Start with both forms across the tracked trees:

```sh
rg --hidden -n -e '<old form>' -e '<new form>' packages scripts .ai .github
```

A search cannot find a caller that omits a newly required field: keep executable
fixtures in typed modules and use the root typecheck, including its coverage guard.
Review active spec rules and case-table rows for semantic changes; edit the rules
themselves. A dated note alone preserves old rules only in a superseded spec.
Find every construction site of a shared in-memory
object by grepping its type, not its field, and give it one factory where a new
required field fails to compile. For saved data and user-facing messages, search both
the old and new form. Follow [saved-format compatibility](BACKWARD_COMPATIBILITY.md).

Changes to a run state or how a run leaves an existing state (an exit trigger or
recovery path), cross-run relationship, ToolGrant mapping, running task's
worktree files, detached process or restored client state need the applicable
[case tables](.ai/specs/TEMPLATE.md#case-tables) in the spec or plan before implementation.

## CI surface rules

[SDLC.md](SDLC.md#validation-gate) owns validation policy. The
[CI guide](docs/sdlc/ci.md#ci-verification),
[workflow](.github/workflows/ci.yml) and
[change classifier](.github/scripts/change-surface.cjs) define the checks and
permitted skips. Use those sources for review rounds, finding settlement and
readiness. Required checks must pass on the current head before merge.

Reuse successful evidence for unchanged tested inputs. Later code edits need
checks of the affected behavior. A targeted run or permitted skip is not a full
pass. CI owns the exhaustive gate; a new commit or review round alone does not
require another full local run.

## Severity guidance

Report concrete defects introduced or exposed by the diff. Each finding names
the triggering input or sequence, the violated behavior or explicit repository
guarantee, the consequence, and the supporting file and line. Give a useful
correction and describe the test that would catch it.

Set severity from the consequence. Optional style, wording or refactor advice
does not justify blocking a change. Missing tests alone are not a product defect;
explicit repository verification requirements still apply. Use the current
[automated review policy](docs/sdlc/ci.md#ci-verification) for automated finding
thresholds and disposition.

Request changes for material unresolved defects or unmet required verification.
A review approval does not grant merge authority; follow
[SDLC.md](SDLC.md#merge-authority) for landing.
