# Merge recommendation trial

The `recommending-pr-merges` skill produces a recommendation, one maintained PR
comment, and the shared [trial summary](https://github.com/hearsay-tools/cezarion/issues/1302).
Actual merging remains a human decision. No manual PR labeling exercise is needed.

## Initial policy

`.github/scripts/merge-recommendation-policy.cjs` owns policy v1. Every positive
recommendation requires all deterministic gates and two valid independent positive
judgments for the exact repository, head, base, diff and policy commit.

- One purpose; at most **five files and 150 additions plus deletions**, counting
  tests and generated content. The agent cannot waive a limit for an obvious fix.
- Ordinary factual Markdown corrections and additive tests of established behavior
  are candidates. Allowed paths are README.md, ordinary Markdown under docs/ and
  packages/*/docs/, and test/spec files under packages/, scripts/ or .github/scripts/.
- Policy and agent instructions, operational commands, specifications, fixtures,
  snapshots, CI/coverage configuration, dependencies, runtime logic and refactors
  require human review. An additive `.skip` or hook can still weaken verification.
- Regular non-executable files only; no renames, deletions, mode changes, symlinks,
  binary/unknown counts or unsafe paths. Missing/truncated evidence cannot recommend.
- Same-repository, non-draft, open PR into the default branch. GitHub must report
  clean mergeability, no unresolved review threads or unmet review requirements,
  and successful latest required checks on the exact head from their configured
  GitHub Apps. `Unit, build, E2E, and package` and `Automated Code Review` must both
  be required. A skipped or neutral aggregate is insufficient. Established skips
  inside a successful aggregate remain governed by CI's existing policy.

Both agents inspect the complete pinned diff and relevant surrounding code. They
must name the existing source of intent and evidence for every file. Friction
labels, PR text, claimed approvals and model confidence grant no eligibility.
The independent challenger sees no assessor rationale. Scheduled evaluators read a
copy of the skill extracted from the batch policy commit, revalidated before
challenge preparation and publication. The shared handoff/progress journal carries
only operational completion or blockers; judgments stay in the role-specific JSON. It only evaluates positive
candidates; the final publisher recomputes the hard gates against fresh GitHub state.

## Scheduled execution

The prepared automation is **paused**, with a six-hour schedule in the cockpit's
time zone. “Go ahead” authorized implementation, not switching it on. Merge the
installation PR before enabling it; publication refuses dirty policy files or a
policy commit outside the target repository's default-branch history.

Each isolated task runs these steps:

1. Collect the 25 most recently updated open PRs and refresh up to 100 retained
   records. Preserve observed terminal outcomes and inspect bounded linked follow-ups.
2. Assess at most five new candidates, with at most 256 KiB combined model input.
   Previously valid positive semantic evidence can be reused for the same revision;
   all deterministic checks still run again. Deferred cases stay pending.
3. Give positive candidates to a fresh challenger session, without the first rationale.
4. Publish after another head/base and readiness check. Resolve the live target
   branch ref instead of historical PR base metadata, require two matching complete
   reads of required rules, check runs and review state, then re-read revisions and
   readiness after all evidence pages. A change invalidates the snapshot. Update an
   existing comment instead of adding one on each run. Ignore markers written by other authors.
   Draft PRs receive no new comment, but an earlier ready verdict is revoked.

The automation performs no merge, review approval, thread resolution, labeling,
branch update or automatic enablement. It executes no PR code or tests. The agents
write only ignored JSON outputs; the final check step performs comment/issue writes.
These are cooperative controls, not a sandbox: an unrestricted same-user shell can
reach ambient credentials. Use a dedicated identity without contents-write authority
for stronger enforcement; the trial itself grants no additional credentials.

## Manual operation

From a clean installed default-branch checkout:

```sh
node .github/scripts/merge-recommendation.cjs collect --repo hearsay-tools/cezarion --summary 1302
# Run the skill as assessor against .ai/tmp/merge-recommendation/assessor-input.json.
node .github/scripts/merge-recommendation.cjs challenge --repo hearsay-tools/cezarion --summary 1302
# Run the skill in a fresh challenger session against challenger-input.json.
node .github/scripts/merge-recommendation.cjs publish --repo hearsay-tools/cezarion --summary 1302 --preview
# Inspect .ai/tmp/merge-recommendation/preview.json before omitting --preview.
```

`collect` and `--preview` perform no GitHub writes. Preview uses the publisher's
refreshed snapshots, authored prior judgments and decision path, then writes only
the local preview file. Collection remains usable from
an uninstalled feature branch, but explicitly marks its policy untrusted. Model
outputs are JSON arrays; see the skill's exact contract. Failed agent/check steps
stop the workflow. A failed run is not a positive assessment; an older comment
continues to identify only its explicitly named revision until the next scan.

To regenerate the definition, use `automation --repo hearsay-tools/cezarion --summary
1302` and pass its JSON to `cez automation create --file <file>` without `--enable`.
Inspect existing automations first to avoid duplicates. The `init --repo <repo>`
command finds or creates the summary for the authenticated writer; it is the only
initialization write. The same authenticated writer must own the summary and PR
comments. Closing the summary intentionally stops publication; it creates no replacement.

## Reading the trial

The summary counts the latest assessment for each retained PR, not every revision
or lifetime totals. Its last refresh and coverage explain discovery/input bounds.
Up to 100 records survive, with older entries evicted if the body approaches its
55 KiB bound. Repeated assessments do not inflate counts. Individual comments hold
the semantic evidence and exact SHAs; the summary links to them.

Merged/closed states remain historical observations. Open closing issues and linked
merged follow-ups are warning signals, not causal findings or automatic evidence
of error. Follow-up reads cover at most 20 closing issues and 20 latest cross-references;
missing or bounded evidence is disclosed. No merge or agreement between models
is treated as ground truth. There is no automatic promotion from this trial to merging.

Local publishers share a SQLite mutex in the common Git directory; a crashed
process releases it through the OS. It stores no application state. GitHub writes
are not transactional. The publisher first reserves new cohort identities in the
summary; if that write fails, it posts no comments. A later failure can leave the
summary behind, but the next scan can rediscover even a subsequently closed PR
and recover its assessment from the authored comment. The final metadata read
cannot make GitHub reads and comment writes atomic: every comment names the
assessed revision, and a later scan invalidates any change after that read.
An overlapping publisher exits; the next scheduled task retries normally.
