# Session-start context

Cezarion puts context at the start of the opening message of every session it launches. The
agent then has its handoff notes, and any project context you add, without spending a tool call
to read them (hearsay-tools/cezarion#1584).

## When it applies

Context is added when Cezarion launches a session:

- a fresh agent step, including a later step of a workflow;
- a step that runs again after a failed check (`onFail.retry`);
- **Continue**, from the cockpit or `cez task send <id> … --resume`;
- restart recovery, the usage-limit auto-resume and other scheduler continuations;
- an owned worker's sessions, which render the context for the worker itself.

Ordinary messages you send to a live session get no context. Native compaction inside a
session does not add it again.

## The handoff block

The first block is always the run's own handoff file (`CEZ_HANDOFF_FILE`), complete: Goal,
Progress log, Resume notes and the Autosave section. It needs no configuration, and it cannot be
turned off or replaced. A worker gets its own handoff, never its parent's.

When the handoff is in the message, the system prompt tells the agent so, and asks it to read the
file again only for a later version. When the handoff could not be added (the file is missing or
unreadable, or it does not fit the limit), the system prompt keeps the instruction to read the file.
The agent still has to keep the Progress log and the Resume notes up to date in both cases.

## Project rules: `.ai/cezar/context.yaml`

Add project context with an optional `.ai/cezar/context.yaml` in the project root. Cezarion reads
it from the project root (the checkout Cezarion runs in), not from the task worktree. A missing
file means no custom rules, with no warning. The file is not git-ignored, so you can commit it.

```yaml
version: 1
rules:
  - id: project-vision
    on: session_start
    target: both
    template: |
      Project vision:
      {{file:docs/vision.md}}
  - id: worker-brief
    on: session_start
    target: worker
    template: |
      You are worker {{run.id}}. Report to your parent before you finish.
```

| Key | Meaning |
| --- | --- |
| `version` | Required. Must be `1`. |
| `rules` | A list. Rules are rendered in this order, after the handoff. |
| `id` | Required and unique. 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. `handoff` is reserved. |
| `on` | Required. `session_start` is the only trigger. |
| `target` | `parent`, `worker` or `both` (the default). `parent` is every task that is not an owned worker. |
| `template` | Required. Text with `{{…}}` substitutions. |

### Substitutions

| Token | Value |
| --- | --- |
| `{{task}}` | The run's task text |
| `{{run.id}}` | The run id |
| `{{role}}` | `parent` or `worker` |
| `{{workflow.name}}` | The workflow name |
| `{{step.id}}` | The id of the step being launched |
| `{{project.root}}` | The project root |
| `{{worktree.root}}` | The session's working directory |
| `{{handoff.path}}` | The run's handoff file |
| `{{file:<path>}}` | The contents of a file, by a path relative to the session's working directory |

Substitution is one pass over the template. Text that a variable or a file inserts stays
literal: a `{{…}}` inside it is not expanded. A `{{file:…}}` path must stay inside the session's
working directory after symlinks resolve; absolute paths, `..` escapes and symlinks that leave
the worktree are refused. A file must be valid UTF-8. There are no commands, conditionals,
loops, globs or remote sources.

Cezarion reads the rules and the files again for each launch. The text a launch receives does not
change after the launch starts.

## Limit

The whole prefix, labels and separators included, can be at most 65,536 bytes of UTF-8. The
handoff is added first, then the rules in file order. A block that does not fit is left out whole,
never cut, and the later blocks are still tried.

## What the agent sees

```text
<cezar-context id="handoff" source="/path/to/.ai/cezar/runs/<run>.handoff.md">
# Handoff — …
</cezar-context>

<cezar-context id="project-vision">
Project vision:
…
</cezar-context>

---

<the opening message>
```

When the opening message starts with a slash command (`/name`), the launch gets no context, so
that the backend still sees the command at the start. The agent keeps the instruction to read the
handoff file.

## Errors and reports

Errors never stop a launch:

- A `context.yaml` that cannot be read or parsed, or has another `version`, skips every custom
  rule. The handoff still applies.
- An invalid rule, a duplicate `id` (every rule that has it), the reserved `handoff` id or an
  unsupported `on` value skips that rule.
- An unknown or unavailable variable, or a missing, unreadable, non-UTF-8 or outside file, skips
  that rule.
- A block over the limit is skipped.

The other rules still run. Each launch writes one lifecycle line to the task log, which the
cockpit and headless `cez run` both show:

```text
session context: handoff applied (2431 B, /…/runs/<run>.handoff.md); project-vision skipped (docs/vision.md) — file docs/vision.md: not found
```

The line names each block, its size, the files it read and why it was skipped. It never contains
file contents. `applied` means the block is in the launch's opening message, not that the provider
confirmed it.

## Native resume

A runner that resumes its own native session keeps that session's history. Context injected at
an earlier launch stays in the history, and native compaction can summarize or drop it; Cezarion
does not add it again until the next launch. Claude keeps the system prompt of a session's first
launch when it resumes (see `AGENT_PROTOCOL.md`), so a session that started before this feature
can still be told to read the handoff file. Both instructions are safe: the file is the same one.
