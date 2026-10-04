# hearsay-tools/cezarion#662 fix #1 measurements

Measured 2026-09-28 on this host/account against `e97c6314`. Before ran before production edits; the final after run used the verified working diff with verification idle. The JSON commit field is baseline HEAD; the after implementation was uncommitted.

Live loopback HTTP request-to-body-parse timing, not browser click-to-paint. These small sequential samples include host/network variation and are not a p95 estimate. Subprocess count reduction does not imply proportional wall-time savings. CLI durations combine process startup, authentication, transport and GitHub processing.

## HTTP totalMs

| Scenario | Before median (range), ms | After median (range), ms | Repo-view counts before → after |
|---|---:|---:|---|
| cold-ref | 1174.36 (985.53–1525.48) | 1124.15 (1072.59–1434.63) | 1,1,1,1,1 → 1,1,1,1,1 |
| warm-ref | 1.40 (0.99–3.05) | 1.24 (1.02–3.00) | 0,0,0,0,0 → 0,0,0,0,0 |
| warm-handle-cold-ref | 676.71 (675.72–2171.32) | 836.25 (543.46–908.17) | 0,0,0,0,0 → 0,0,0,0,0 |
| concurrent-overlap | 1107.87 (1106.34–1109.40) | 1450.87 (1450.78–1450.95) | 2 → 1 |
| 20-recent-prs-warm-handle | 1864.63 (1764.49–3220.35) | 1878.25 (1797.53–2023.21) | 0,0,0 → 0,0,0 |
| list-refresh-1000 | 1928.06 (1767.41–2450.56) | 1717.13 (1409.05–1836.03) | 1,1,1 → 0,0,0 |
| list-warm-1000 | 2.45 (2.30–2.96) | 2.51 (2.45–2.62) | 0,0,0 → 0,0,0 |

Each warm list refresh removes one previously measured 369.08–412.30 ms repo lookup. Overlapping batches share one discovery and query each distinct reference once, with separate batches for newly owned numbers. Identical batch coalescing has a one-query regression test.

## List refresh gh spans

Cells contain `startMs + durationMs`, ordered by sample. Two counts queries run per refresh. Concurrent spans must not be summed as wall time.

| Command | Before spans, ms | After spans, ms |
|---|---|---|
| repo view | 1.23 + 412.30; 0.44 + 387.90; 0.62 + 369.08 | none; none; none |
| issue list | 413.59 + 784.44; 388.40 + 1489.98; 369.79 + 856.01 | 1.28 + 805.59; 0.61 + 854.96; 7.70 + 1028.24 |
| pr list | 421.90 + 782.62; 394.69 + 716.67; 380.96 + 575.93 | 6.60 + 785.52; 5.41 + 885.55; 12.84 + 617.86 |
| counts-graphql | 426.36 + 994.25, 429.11 + 465.42; 397.85 + 1227.76, 402.33 + 698.01; 385.89 + 981.58, 389.48 + 488.03 | 9.08 + 1075.76, 11.39 + 644.71; 7.42 + 1002.70, 9.29 + 492.14; 15.35 + 985.06, 17.45 + 510.73 |
| viewer-graphql | 433.12 + 423.75; 406.99 + 662.03; 394.27 + 405.54 | 13.88 + 422.06; 11.35 + 403.24; 20.14 + 491.36 |
| projects-graphql | 418.17 + 668.44; 391.96 + 698.76; 376.54 + 475.10 | 4.19 + 429.99; 3.36 + 433.01; 10.44 + 611.04 |
| membership-graphql | 1199.67 + 562.54; 1879.18 + 567.14; 1226.43 + 698.30 | 808.50 + 594.90; 856.33 + 856.97; 1036.82 + 794.93 |

## Overlapping requests gh spans

| Phase | Pair wall time, ms | gh start + duration, ms |
|---|---:|---|
| before | 1109.58 | repo view: 1.14 + 382.15; repo view: 4.95 + 424.32; ref-graphql: 383.34 + 722.05; ref-graphql: 429.33 + 679.48 |
| after | 1451.12 | repo view: 1.24 + 452.08; ref-graphql: 453.53 + 995.99; ref-graphql: 456.72 + 427.29 |

## CLI controls

| Command | Before median (range), ms | After median (range), ms |
|---|---:|---:|
| startup | 50.54 (49.15–56.74) | 54.22 (52.67–60.61) |
| repo | 366.81 (353.83–1204.73) | 436.28 (389.70–801.77) |
| light | 478.95 (431.04–662.93) | 417.91 (397.29–648.31) |
| rich | 633.23 (570.91–647.92) | 721.29 (700.70–770.93) |

## Reproduce

```sh
node --import tsx .ai/analysis/662-github-refresh/profile.mjs
node --import tsx .ai/analysis/662-github-refresh/cli.mjs
```

Raw traces: [before HTTP](fix1-before-http.json), [after HTTP](fix1-after-http.json), [before CLI](fix1-before-cli.json), [after CLI](fix1-after-cli.json). Scripts copied unchanged from diagnosis task `cd07d636`, commit `44dc0e67`. No credentials or GitHub response bodies retained.

An exploratory after run overlapped local verification: list median 1692.30 ms (1601.60–2593.56), no list discoveries, one discovery plus two status queries under overlap. The tables use the final idle run rather than those exploratory timings.

Fixes #2–#4 are left undone: membership deferral, terminal-aware status query changes, and stale-while-revalidate.
