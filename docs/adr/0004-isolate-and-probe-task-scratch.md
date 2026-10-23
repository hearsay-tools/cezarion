# Give each task short, writable scratch space

Each task normally receives its own `TMPDIR`, `TEMP` and `TMP`. Prefer a directory on the
run-state disk to limit dependence on shared host temp space. Probe it with actual bytes
before starting the agent; creating an empty file alone does not test a data write.

The directory must also fit the Unix socket path budget. Use the short repo-local `t/<id8>`
name when it fits, then a digest name under suitable temp roots. Ownership markers protect
against short-id collisions and cleanup across projects.

## Consequences

The resolver can refuse a spawn when no candidate fits or accepts writes. `CEZ_AGENT_TMPDIR=0`
disables isolation, path selection and the probe together.

Session close does not end scratch ownership. Continue needs the files. Terminal cleanup and
startup sweeps retain paths required by live runs or resource holders, and do not remove
paths with uncertain ownership. Cleanup failures must not break terminal settlement.

## Considered Options

- **Inherit the host temp directory.** Available through the opt-out; it shares capacity and scratch with other processes.
- **Use a full run UUID below every repo.** The shorter name preserves more repo-local paths within the socket budget; full ownership remains in a marker.

Implementation: [agent-tmpdir.ts](../../packages/cezar/src/runs/agent-tmpdir.ts), [.env.example](../../.env.example).

Coverage: [agent-tmpdir.test.ts](../../packages/cezar/src/runs/agent-tmpdir.test.ts), [agent-tmpdir.test.ts](../../packages/cezar/src/workflows/agent-tmpdir.test.ts).
