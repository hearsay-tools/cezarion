Execution environment: this is a read-only sandbox. `/tmp`, `/var/tmp`, and
`/usr/tmp` are unwritable. `pytest` and `uv` are absent and exit 127;
`npm run <script>` finds npm but fails when `node_modules` is absent
(`tsx: not found`); and `python -m unittest` starts but its setup fails with
`No usable temporary directory`. Do not repeatedly probe the Python suite or
guess alternate module paths. The available tools include Python 3.12.3, Node
v24.19.0, npm 11.17.0, git, rg, sed, nl, jq, find, `node --test`, yamllint,
and `python -c` with `compile(...)` for non-writing syntax checks.

Read `.review-context/ci-results.md` for the `CI` workflow's test
conclusion, including failing job names and output. If that file says the
run has not finished, treat the tests as pending and do not run the suite.

Review this pull request for actionable bugs.

A change under `packages/web/e2e/` that fixes or retries a flaky spec must cite a
failure bundle or a local reproduction (see `packages/web/e2e/README.md`); report
one that cites neither, and report any growth of
`packages/web/src/test/e2e-wait-discipline.baseline.json`.

Inspect the merge-base diff between the pull request head and its base, then
report only defects introduced or exposed by changed lines. Do not report style,
formatting, speculative concerns, or issues whose fix is not clear and useful to
the author. Each finding must point to a changed new-side line.

On later rounds, read earlier automated review bodies from
`.review-context/prior-review-bodies.jsonl` and inline review comments from
`.review-context/prior-inline-comments.jsonl`. Group those inline comments
by thread using `id` and `in_reply_to_id`. For each earlier actionable
finding, meaning every thread whose root comment (the one with no
`in_reply_to_id`) was written by `github-actions[bot]`, read the whole
thread, not only the original body, and return one `prior_findings` entry:
`comment_id` is that root comment's `id`, `verdict` says whether it was
addressed or remains unresolved, and `reason` names its location and reason
in one or two sentences. Treat implementer replies as evidence: valid
pushback (a sound disagreement, or a won't-fix whose reason holds) counts as
addressed even with no code change. Invalid pushback stays unresolved and
names why the reply fails, not only that the code did not change. Never
re-file a finding that already has a thread; its `prior_findings` verdict
carries it. Do not resolve review threads yourself: CI posts each reason as
a thread reply and resolves the addressed ones. On a first round, or for a
skipped or failed outcome, return an empty `prior_findings`.

Read `.review-context/pull-request.json` for the resolved `pr_number`,
`head_sha`, and `base_sha`. Set the output `head_sha` to that exact `head_sha`
string and use those refs for the merge-base diff. This context works for both
PR events and manual dispatches, whose event payload has no `pull_request`.
Do not derive review metadata from `$GITHUB_EVENT_PATH` or use the checked-out
merge commit SHA. If the context is missing or its SHAs are invalid, return
`outcome: "failed"` with no findings and explain the missing metadata.

Emit only one JSON object that conforms to the supplied output schema. Set
`outcome` to `reviewed` only after you inspected the complete merge-base diff.
Set `outcome` to `skipped` only when the pull request intentionally does not
need review, and explain why in `summary`. Set `outcome` to `failed` if required
data or tools are unavailable or the review cannot otherwise be completed, and
explain the failure in `summary`; use `null` for `head_sha` only when its exact
value is unavailable. For skipped or failed outcomes, return no findings.

For a reviewed outcome, set `findings` to an empty array when there are no
actionable bugs. Every finding must include `severity`; set it to `null` when no
severity is useful. Always include `summary`; set it to `null` unless it adds
useful overall context, and never repeat a finding in it.
