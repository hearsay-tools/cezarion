# Separate selective Vitest pilot

The owner requested preparation and execution of the guarded pilot after reviewing
the report. The experiment must sit outside the main verification flow. Browser
optimization is separate and does not decide this experiment.

The load-bearing guarantee is that required CI runs every discovered unit suite
before merge. The pilot leaves that guarantee and all existing commands untouched.
It uses an isolated branch-push workflow with read-only permissions, five frozen
application commits and paired full/selective runs on each of four shards. No PR
or change to main is needed. No required check or canonical coverage artifact is
produced. Its evidence is advisory and includes failures.

| Case | Candidate behavior | Evidence |
| --- | --- | --- |
| Ordinary source with importers | Import graph plus mandatory source invariants | Exact graph, guard and executed file lists |
| Source scanner outside import graph | Always include declared and known source guards | Reproduced contract-import scanner is required |
| Contract/configuration/lockfile/scripts/unknown input | Full fallback | Original selector reason and complete inventory |
| Removed or renamed input | Full fallback | Original selector's missing-input decision |
| No graph matches | Full fallback before adding guards | Unit case pins the ordering |
| Missing Git/base or graph error | Full fallback; no partial pass | Error/fallback recorded |
| No selected tests on one shard | Reject unexpected emptiness | Actual inventory equals expected allocation |
| Full fallback control | Execute full in both modes | Measures noise and selector overhead |
| Failed test or command timeout | Keep failure, execute other mode, upload evidence | Native JSON, log, time and exit status |
| Partial coverage | Distinct advisory artifact | Never substitutes for current full CI coverage |

The matched sample covers narrow test edits, a web source change, a shared server
change, a smaller server source change and a contract fallback. It uses one
repetition per source with counterbalanced order across shards. Judge net runner
command time (candidate includes selection), longest Vitest command and missed
failing files. This is not enough to establish an exhaustive false-negative rate.
