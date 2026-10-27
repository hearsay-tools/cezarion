# Historical timer parity diagnosis

Subject: hearsay-tools/cezarion#1298. Parent approved this constrained plan on 2026-10-27.

## Evidence and scope

Current proof_base: `e53bef4e9997e4dde9794f08b09c62900fb82eed`.
Historical U8 head: `dd209a6aa`, CI run 39311043388 attempt 1.
Historical U21t head: `6fd568617`, CI run 39526510886 attempt 1.
Original logs are retained in ignored `.ai/qa/1298/`.
The startup repair in hearsay-tools/cezarion#1560 does not prove either remaining failure.

1. Map original event tails to historical checkpoints and source versions.
2. Run bounded scratch probes with named checkpoints. Use CPU 0 for controlled load. Start with two competitors and increase only if useful. Record every result and clean up all owned processes.
3. Change only `packages/cezar/src/workflows/waits-parity-cells.testkit.ts` if evidence supports a test signal-ordering fix. Preserve predicates and assertions, the 15-second phase guard, and the 45-second row bound. Ask the parent before changes to product code, shared fixtures or mocks, or a different repair.
4. Prove failure before and pass after at a pinned base in a disposable checkout or ignored scratch copy. Verify relevant parity cells with Squeal and server test typecheck. CI owns broad validation.
5. Open a draft PR to main only for a supported repair. Keep the issue open unless historical failure reproduction and acceptance are complete. Parent reviews and merges.

## Guarantees retained

U8 must observe a blocked competing run while the parked run receives its wake without entering the queue at maxParallel 1. Both runs must re-park.
U21t must preserve the explicit timer deadline beside the deadline-free completion wait. Each wake is delivered once; timer settlement leaves completion open, and worker settlement still wakes the parent.

## Uncertainty

The old U21t used CEZ:MONITORING to open its timer. Current U21t deliberately requires an explicit timer instead. A failure of the old marker predicate against current product code is not historical proof.
