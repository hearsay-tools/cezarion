# Inherited refactors

Resolve the destination repository from the task's issue tracker binding and
confirm it with `gh repo view --json nameWithOwner`. Pass `--repo <owner/repo>`
on each issue and label command.

Search open issues for the file and function before creating one. Reuse an issue
only when it covers the same refactor. Search across all labels; an older issue
may lack the label. Add `code-quality-improvement` to a reused issue if needed.

Ensure that exact label exists. List labels with `gh label list --repo
<owner/repo> --limit 1000 --json name`; if absent, run:

```sh
gh label create code-quality-improvement --repo <owner/repo> \
  --color 5319E7 --description "Code quality refactors identified during change checks"
```

If creation reports that the label already exists, read it again and continue.
Other errors remain filing failures. Keep existing label settings.

Write the issue body to a temporary UTF-8 file, then submit it with
`gh issue create --repo <owner/repo> --label code-quality-improvement
--title <title> --body-file <file>`. The title should name the function and the
needed improvement. The body must contain:

- The repository path, function, pinned baseline SHA and current revision or
  source hash. Link committed source with a repository-qualified permalink.
- Current complexity, body line coverage and CRAP; name the exceeded limit from
  the scan report. Include baseline evidence and commands that reproduce it.
- Why the problem predates this task, why a small change is insufficient and
  what behavior the refactor must preserve.
- A concrete refactor direction and acceptance criteria: preserve behavior,
  keep relevant tests passing and bring both scores within the policy limits.

One issue can cover functions that require the same refactor. Keep unrelated
refactors in separate issues. Record the returned URL for every deferred finding.
After an ambiguous create failure, search again before retrying so that a lost
response does not create a duplicate. Remove temporary body files after filing.
