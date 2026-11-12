# Follow an auto-merge PR until it merges

Use this file for a PR you opened with the `auto-merge` label, right after you open
it, before each push to it, and after each push, CI result, review round,
draft/ready change and quality-report completion.

## Squash, always

Every merge is a squash: pass `--squash` on every command. The repository also
allows merge commits and rebase. One commit per PR, titled `<PR title> (#<n>)`,
lets the owner trace a dev-channel problem to its PR and revert it with one
`git revert`.

## Act on the PR's state

Follow the PR as usual: wait for CI, fix failures, answer review threads. Open
the PR ready. The readiness workflow never changes draft state; it moves the
board card only. Read
`gh pr view <n> --json state,isDraft,autoMergeRequest,headRefOid,labels`.
Read queue membership separately with GraphQL (the `gh pr view --json` field list
does not include it):

```bash
gh api graphql -f owner='<owner>' -f repo='<repo>' -F number=<n> -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){isInMergeQueue}}}' --jq '.data.repository.pullRequest.isInMergeQueue'
```

Act on the first row that matches:

| State | Action |
| --- | --- |
| `MERGED` | Finished. |
| No `auto-merge` label | The owner took the PR back. If `autoMergeRequest` is set, turn the request off first: `gh pr merge <n> --disable-auto`. Then follow it as an ordinary PR. |
| A push is about to happen | Do not arm on this visit. If auto-merge is armed, turn it off first: `gh pr merge <n> --disable-auto`; an armed request never carries across a push. Push, then act on this table again for the new head. |
| New head or title since your last decision | Run the decision in [`.ai/skills/auto-merge/SKILL.md`](../SKILL.md) again. On `DOES NOT QUALIFY`, leave auto-merge. A request left armed across the new head does not carry: turn it off (`gh pr merge <n> --disable-auto`) and arm it again only as the `autoMergeRequest is null` row says. |
| `isInMergeQueue` is true | A reviewer round on this head with a finding scored 5 or more takes the request off (`gh pr merge <n> --disable-auto`), which dequeues the PR; fix and push as the rows below say. Otherwise the merge is pending. Keep following it with `until: "merge_or_blocked"`; a null `autoMergeRequest` does not mean it needs another merge command. |
| `autoMergeRequest` is null | Arm it only when both preconditions of [`.ai/skills/auto-merge/SKILL.md`](../SKILL.md) hold for this head: the reviewer round has no finding scored 5 or more, and the changed-function quality report is complete with no blocker. Then run `gh pr merge <n> --auto --squash --match-head-commit <headRefOid>`: the request arms only the head the preconditions were checked on. When the command reports the head moved, start this table again for the new head. When GitHub refuses because the PR is a draft, leave it as a draft and tell the owner it needs promotion: no workflow promotes a draft, including one a saved automation opened. When GitHub answers that the PR is in clean status, merge it now: `gh pr merge <n> --squash --match-head-commit <headRefOid>`. |
| `autoMergeRequest` is set | A later reviewer round on this head with a finding scored 5 or more takes the request off: `gh pr merge <n> --disable-auto`. Fix, push, and arm again for the new head. Otherwise wait for the next event. |

After requesting a merge, keep responsibility for the PR and register:

```json
{ "kind": "pr", "pr": "<PR URL>", "until": "merge_or_blocked" }
```

End the turn to park. `merged` confirms success. `blocked` reports a conflict or
that neither queue membership nor enabled auto-merge remains; inspect its current
state and any removal reason before taking action under the existing merge rules.
Do not re-enqueue merely because a wait woke. A `deadline` or `error` leaves the
merge unresolved: inspect and register another wait, or hand responsibility to the
human. Queue admission is not completion.

An agent whose work only depends on another PR merging uses `until: "merge"`
with `wake_on_conflict: false`; queue removals do not wake it. When this PR is still
a draft, follow its checks or use a short timer rather than supervising a merge
that has not been requested.

**Done when** the state is `MERGED`, or you left auto-merge.

## While the PR is open

- Leave every review thread for the reviewer to resolve. Fix the code and push:
  the reviewer resolves a thread it judges Addressed. When you disagree with a
  finding, reply with your reason and continue the discussion with CodeRabbit. The trusted reconciler refreshes admission;
  for eventless thread reopening or resolution, see AGENTS.md § Dev flow bindings.
- Fix a CI failure at its cause. When a wait or a timeout must change, give the
  reason at the site (`// bound: <reason>`) and list the change under Disclosed.
  List every re-run of a failed job there too.

## Leave auto-merge

Leave when a rule of the decision stops holding, when a review thread stays unresolved after the reviewer answers, or when the owner comments on the PR or asks for
changes:

```bash
gh pr merge <n> --disable-auto
gh pr edit <n> --remove-label auto-merge
```

Then say in a PR comment which rule or event took the PR back, and follow it as an
ordinary PR.
