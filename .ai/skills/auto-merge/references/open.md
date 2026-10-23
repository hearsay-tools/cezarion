# Open an auto-merge PR

Use this file after the PR passed the decision in
[`.ai/skills/auto-merge/SKILL.md`](../SKILL.md).

The `auto-merge` label and the PR's `## Auto-merge` section show the owner what
merged without review, so the owner can tighten the rules where something
slipped. Write the section for that reader.

Open the PR as a draft, as usual. Add the label
(`gh pr edit <n> --add-label auto-merge`) and this section to the body:

```markdown
## Auto-merge
Qualifies: check.mjs QUALIFIES at <short head SHA>, <N> files, <M> lines.
Watch in dev: <what a user would see if this change is wrong, or "nothing visible">.
Disclosed: <raised timeouts, added retries or skip conditions, removed assertions, re-run CI jobs, or "none">.
```

**Done when** the PR is open with the label and the section. Then read
[`.ai/skills/auto-merge/references/follow.md`](follow.md) and act on it now: its
table enables auto-merge.
