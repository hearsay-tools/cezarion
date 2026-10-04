# Documentation citation audit — hearsay-tools/cezarion#691

Audited the tracked tree at `537780c0` on 2026-10-05. This is documentation
verification, not a claim that the application gate ran. The integrating parent
owns the final six-command gate and independent review.

## Coverage and method

- Enumerated with `git ls-files -z`, not a recursive scan of ignored runtime state.
  Covered 356 tracked text documentation/config/mockup paths: all `.ai/` Markdown,
  JSON, YAML, HTML and CSS, plus `AGENTS.md`, its `CLAUDE.md` symlink,
  `AGENT_PROTOCOL.md` and `README.md`. The only tracked repository `SKILL.md` is
  `.ai/skills/om-prepare-test-env/SKILL.md`; it has no issue/PR citations. The tracker
  operation guide it works alongside now uses the same citation convention.
- Searched both `#` followed by digits and forms such as `PR 675`, `issue 522`
  and `issue-438`. The initial broad search found 1,701 candidate lines in 288
  paths; this intentionally includes CSS colors, sample UI values and filenames.
  Reviewed those contexts rather than treating regex matches as citations.
- Also inspected all 18 tracked `.log` files and both `.log.gz` files, decompressing
  the latter in memory. All 20 are byte-identical to the fork-point versions;
  only `2026-07-17-disable-global-inbox/final-gate-artifacts/manual-probe.log`
  contains a candidate. Its companion `final-gate-checks.md` explicitly attributes
  that retained log to `open-mercato/cezar#471`.
- Scanned the tracked `.ai/scripts/` sources as a boundary check. Their code
  comments are outside this documentation change; no scripts, configuration,
  runtime code, workflows, schemas, labels or port behavior were changed.
  PNG screenshots are retained binary evidence, not rewritten citation text.
- Used `ledger.yaml`'s `origin.mergeBase`:
  `feb856667e489c0b4d9973e5b23eaa9aee0fa924` (2026-08-31). Compared each archive
  against `git show <mergeBase>:<path>`; a filename's date alone was never the
  attribution rule. Added local upstream source notes to 167 unchanged Markdown
  archives. Their bodies still match that snapshot after removing the source
  notes and the two explicitly qualified Open Mercato application references.
- Queried both trackers with
  `gh api --paginate 'repos/<owner>/<repo>/issues?state=all&per_page=100'`, retaining
  only number, title and URL for inspection: 822 fork records and 1,269 upstream
  records at audit time. Checked mixed documents against those titles, their
  existing links and `git log -S` history. Counts include issues and PRs.

The cleanup adds 469 numeric repository-qualified citations across the existing
files (including the generated ledger view), local provenance for historical
archives and scans, and 12 mockup title/comment/caption corrections. UI sample
chips, queue ordinals, CSS colors, numbered specs, protocol markers, command
arguments and test-name filters retain their meanings. The immediate-delivery
implementation plan has a local fork citation scope so its literal test filters
continue to select the existing tests. Existing qualified GitHub links, including
historical `wjarka/cezar` links, are preserved.

## Provenance cross-checks

| Reference | Evidence and resulting attribution |
| --- | --- |
| Monitoring durability and wake regression | `open-mercato/cezar#661` and `open-mercato/cezar#810` tracker titles and pre-fork docs identify the old monitoring work. They are not the fork's serve CPU and sidebar-limit tickets. |
| Serve CPU regression coverage | `AGENT_PROTOCOL.md` R20/R21 belongs to `hearsay-tools/cezarion#661`: `git log -S 'R20/R21 (#661)' -- AGENT_PROTOCOL.md` finds `84aa9142`, whose commit body closes that fork issue. The same number therefore legitimately has different repositories in different paragraphs. |
| Continuation skills versus sidebar sections | `open-mercato/cezar#811` is missing registry skill expansion. The 2026-10-04 multi-project spec amendment is `hearsay-tools/cezarion#811`, “Reorganize sidebar task sections.” |
| Runner/grouped agents versus CI wait | The old grouped-subagent citation is `open-mercato/cezar#474`; the newer CI-wait contract is `hearsay-tools/cezarion#474`. Likewise the original AskUser work is `open-mercato/cezar#473`, while the continuation step-rail regression is `hearsay-tools/cezarion#473`. |
| Pi runner versus temporary-directory path | `open-mercato/cezar#387` adds Pi; `hearsay-tools/cezarion#387` reports the long TMPDIR socket-path failure. Both remain in their respective protocol/README contexts. |
| Old spec with new amendments | Worktree-retention still cites `open-mercato/cezar#483`, but its worker-reclaim and footer corrections cite `hearsay-tools/cezarion#575` and `hearsay-tools/cezarion#570`. The monitoring wake spec likewise combines upstream history with `hearsay-tools/cezarion#59`. |
| External OpenCode source | `gh api repos/anomalyco/opencode/issues/46842` identifies “prompt_async on a busy session persists the message but never schedules a turn”; both formerly abbreviated `opencode` citations now say `anomalyco/opencode#46842`. |
| External application task references | `git show f52748dc` records the original example. Both `open-mercato/open-mercato#4326` and `open-mercato/open-mercato#5366` have the matching devices-registry/mobile-push PR title. They are explicitly qualified rather than assigned to cezar. |
| External activity-log research | The research note already links `https://github.com/openai/codex/issues/19891`; its prose now says `openai/codex#19891`. |
| Ledger | All 91 entry identities and upstream titles remain unchanged. `title`, `sha`, `pr` and `date` describe upstream; `fork.*` describes the fork. Free-form decisions now qualify both trackers, including the upstream draft dependency `open-mercato/cezar#940`. The local README and YAML comments document source-title attribution. |

## Remaining citation debt

These four references are retained, not attributed by guesswork. Include this
table in the PR's remaining-debt section:

| File:line | Unresolved reference |
| --- | --- |
| `.ai/specs/2026-07-24-long-running-waiting-sessions.md:38` | Production PR 4452 (two mentions on this line). |
| `.ai/specs/2026-07-24-long-running-waiting-sessions.md:39` | Production PR 4457. |
| `.ai/specs/2026-07-24-long-running-waiting-sessions.md:40` | Production PR 4461. |
| `.ai/specs/2026-07-24-long-running-waiting-sessions.md:41` | Production PR 4465. |

The source names the local project `mercato-development`, not a repository slug.
`open-mercato/cezar#654` links an Open Mercato application PR, so that repository
is plausible, but existence of matching numbers is insufficient proof. Its four
tracker titles concern different features, whereas the source calls them
replacement PRs. Resolving this needs the original production run URLs; those
ignored runtime records are outside this tracked-file audit. No other ambiguous
issue/PR citation remains outside the documented archive/source scopes and
literal examples in the requested documentation surfaces.

## Verification

- `npm ci` — passed in this worker worktree (559 packages installed). Its audit
  summary reported 11 existing dependency vulnerabilities; dependency changes
  were outside scope.
- `node .github/scripts/upstream-scan.cjs validate` — passed, 91-entry ledger valid.
- `node .github/scripts/upstream-scan.cjs render` — regenerated `LEDGER.md` from
  canonical YAML; no hand edits to the generated view.
- `node --import ./scripts/test-git-env.mjs --test .github/scripts/upstream-ledger.test.cjs .github/scripts/upstream-scan.workflow.test.cjs`
  — 21 passed, zero failed/skipped; includes committed-ledger validity and exact
  render parity. No new prose-mirroring tests were added.
- One-off structured YAML comparison against `git show HEAD:.ai/upstream/ledger.yaml`
  — all fields, ordering, 91 titles, identities, statuses, dates, hints and links
  unchanged; the only value edits are repository qualification in `reason`/`note`.
- One-off archive comparison against the fork point — all 167 archival bodies
  match after removing the documented annotations/qualifications.
- `git diff --check` — passed. The changed-file inventory contains only Markdown,
  archival mockup HTML citation text and the canonical ledger YAML.

The full application gate was deliberately left to the integrating parent under
the worker assignment. These focused checks do not substitute for that gate.
