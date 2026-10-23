# Follow an auto-merge PR until it merges

Use this file for a PR you opened with the `auto-merge` label, right after you open
it and after each push, CI result, review round and draft/ready change.

## Squash, always

Every merge is a squash: pass `--squash` on every command. The repository also
allows merge commits and rebase. One commit per PR, titled `<PR title> (#<n>)`,
lets the owner trace a dev-channel problem to its PR and revert it with one
`git revert`.

## Act on the PR's state

Follow the PR as usual: wait for CI, fix failures, answer review threads. The
readiness workflow marks the PR ready when every required check passes and no
thread is open; leave that change to it. Read
`gh pr view <n> --json state,isDraft,autoMergeRequest,headRefOid,labels` and act on
the first row that matches:

| State | Action |
| --- | --- |
| `MERGED` | Finished. |
| No `auto-merge` label | The owner took the PR back. Follow it as an ordinary PR. |
| New head or title since your last decision | Run the decision in [`.ai/skills/auto-merge/SKILL.md`](../SKILL.md) again. On `DOES NOT QUALIFY`, leave auto-merge. |
| `autoMergeRequest` is null | Run `gh pr merge <n> --auto --squash`. When GitHub refuses because the PR is a draft, wait for the next event. When GitHub answers that the PR is in clean status, merge it now: `gh pr merge <n> --squash --match-head-commit <headRefOid>`. |
| `autoMergeRequest` is set | Wait for the next event. |

To wait in Cezar, open a `ci` wait on the PR, or a short `timer` wait when the
checks are green and the PR is still a draft.

**Done when** the state is `MERGED`, or you left auto-merge.

## While the PR is open

- Leave every review thread for the reviewer to resolve. Fix the code and push:
  the reviewer resolves a thread it judges Addressed. When you disagree with a
  finding, reply with your reason and use the re-judge path in AGENTS.md
  § Dev flow bindings.
- Fix a CI failure at its cause. When a wait or a timeout must change, give the
  reason at the site (`// bound: <reason>`) and list the change under Disclosed.
  List every re-run of a failed job there too.

## Leave auto-merge

Leave when a rule of the decision stops holding, when a review thread stays "Still
unresolved" after the re-judge, or when the owner comments on the PR or asks for
changes:

```bash
gh pr merge <n> --disable-auto
gh pr edit <n> --remove-label auto-merge
```

Then say in a PR comment which rule or event took the PR back, and follow it as an
ordinary PR.
