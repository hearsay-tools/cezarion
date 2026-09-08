# Shard-balance candidate

`split-observed-durations.json` is an experiment input, not the production manifest. It changes exactly three duration values from `.github/test-durations.json` on `252b749d`, retaining all 376 discovered-file keys and the original provenance. Its additional `_provenance.overrides` record identifies every observation used.

| Suite | Current weight (ms) | Candidate weight (ms) |
| --- | ---: | ---: |
| `worker-wait.test.ts` | 40,819.39 | 40,747.45 |
| `worker-wait-capacity.test.ts` | 74,491.07 | 66,806.86 |
| `worker-wait-durability.test.ts` | 70,627.19 | 69,190.13 |

The current weights were derived by summing original case timings before the file split. The candidate uses actual hosted split-suite elapsed times: median `endTime - startTime` from three repetitions of the `split-shards` variant in [run 34281539246](https://github.com/hearsay-tools/cezarion/actions/runs/34281539246), rounded to two decimals. That run used baseline `76429dcfbd0449ad5e09c116d7abb64bc2730b2c` and harness `75702a7355f33cb3f079a02c66fd167313eb8628`.

Only passed suites with all assertions passed are eligible. Repetition 2 of shard 1 failed in `delegation-integration.test.ts`; its **passed** durability suite remains an eligible timing observation. All nine observations used for the three overrides passed. The failed delegation suite's timing is excluded from the aggregate analysis below; that file uses its two passing repetitions instead. No local test timings enter the candidate.

## Why try this small change

The existing additive assignment predicts 468.51 / 468.52 seconds per shard. Replaying those assignments against medians of the passing hosted observations gives 495.02 / 464.18 seconds. Shard 1 also holds more web suites, which incur jsdom and import overhead absent from suite-only weights.

| Assignment | Measured suite-time sums (s) | Server files | Web files | Total files |
| --- | --- | --- | --- | --- |
| Current | 495.02 / 464.18 | 103 / 116 | 82 / 73 | 187 / 189 |
| Three-weight candidate | 475.44 / 483.76 | 112 / 107 | 76 / 79 | 188 / 188 |

The remaining two files are api-client suites. The existing deterministic longest-processing-time assignment is sensitive to weight order: changing these three values changes shard membership for 339 files. Every file remains assigned exactly once; this is not a three-file-only scheduling change.

Observed current split-variant Vitest wall times were 170.86 / 175.46 / 168.59 seconds for shard 1 and 155.40 / 160.90 / 162.62 seconds for shard 2. The failed repetition is reported, not counted as a passing performance result. [PR 158's final CI run](https://github.com/hearsay-tools/cezarion/actions/runs/34282661962) also had a slower shard 1: the test steps took 174 versus 134 seconds. Host variation is material: that run reported 82.23 versus 56.37 seconds of cumulative import time and 59.57 versus 37.37 seconds of environment time.

## Simulation and limits

A four-worker queue simulation uses the passing hosted suite medians, the existing project ordering, then descending source-file size, matching the installed Vitest 4.1.10 cold-cache `BaseSequencer.sort()` policy. Each next suite starts on the earliest available worker. A sensitivity case adds **assumed**, fixed per-file overhead of 0.5 seconds for server suites and 1.6 seconds for web suites. These overheads were chosen to roughly match the hosted current wall times; they are not individually measured setup times.

That sensitivity case predicts 169.99 / 160.58 seconds for current assignments and 164.05 / 166.28 seconds for the candidate: roughly **four seconds of possible improvement** on the limiting shard. This is a hypothesis, not a measured speedup. Suite contention, imports, startup, CPU and filesystem variability can change when files move between runners. The apparent improvement is smaller than observed runner variation. A pure measured-duration sort override did not consistently improve the simulation, so no sequencing-code change is proposed.

Retain the candidate only if a controlled hosted comparison improves CI wall time while passing the same tests and checks. A more even additive sum alone is insufficient. The production manifest, test cases, four-worker limit and publication gates remain unchanged by this artifact.

## Reproduce the three overrides

Download and extract the six `benchmark-split-shards-{1,2}-{1,2,3}` artifacts from run 34281539246 beneath one directory. With that directory supplied as `RESULTS_DIR`, run this from the repository root:

```sh
RESULTS_DIR=/path/to/34281539246 python3 - <<'PY'
import json, os, pathlib, statistics
source = pathlib.Path(os.environ['RESULTS_DIR'])
current = json.loads(pathlib.Path('.github/test-durations.json').read_text())
candidate = json.loads(pathlib.Path('.github/benchmarks/blacksmith/split-observed-durations.json').read_text())
expected = {
    'packages/cezar/src/workflows/worker-wait.test.ts',
    'packages/cezar/src/workflows/worker-wait-capacity.test.ts',
    'packages/cezar/src/workflows/worker-wait-durability.test.ts',
}
for name in sorted(expected):
    samples = []
    for report in source.glob('benchmark-split-shards-*/vitest.json'):
        for suite in json.loads(report.read_text())['testResults']:
            if not suite['name'].endswith('/' + name):
                continue
            assert suite['status'] == 'passed'
            assert all(case['status'] == 'passed' for case in suite['assertionResults'])
            samples.append(suite['endTime'] - suite['startTime'])
    assert len(samples) == 3
    assert round(statistics.median(samples), 2) == candidate['durationsMs'][name]
assert current['durationsMs'].keys() == candidate['durationsMs'].keys()
changed = {name for name in current['durationsMs']
           if current['durationsMs'][name] != candidate['durationsMs'][name]}
assert changed == expected
assert {k: v for k, v in candidate['_provenance'].items() if k != 'overrides'} == current['_provenance']
print('Verified three overrides, nine passing observations, and all original keys/provenance.')
PY
```

## Compare the actual CI workflow

`python .github/benchmarks/blacksmith/run-comparison.py current` dispatches three matched GitHub/Blacksmith pairs through the existing `ci.yml`, using `bench/ci-{github,blacksmith}-current` refs. Use `candidate` for the candidate refs. Each pair completes before the next starts; every conclusion and full job log is retained. An optional second argument selects the output root (default `/tmp/cez-provider-results`). An existing phase directory is rejected before dispatch to protect prior failures; use a fresh output root for a new campaign.

The dispatch keeps the real verification commands, npm cache behavior, and four Vitest workers. It changes only the runner labels under comparison. Manual CI dispatch does not meet the snapshot job's publication condition, so these measurements include queue, setup, all verification jobs and the aggregate, but exclude publishing. Ordinary PR CI remains the final check including the unchanged GitHub-hosted publication job.

Generate queue-inclusive summaries with `python .github/benchmarks/blacksmith/summarize-ci.py /tmp/cez-provider-results`. The output retains each failed run and its failing test names, while medians use only successful complete runs. Run-created to verification completion includes queue and dependency gaps; summed runner time is reported separately. Validate the summarizer with `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s .github/benchmarks/blacksmith -p 'test_*.py'`.
