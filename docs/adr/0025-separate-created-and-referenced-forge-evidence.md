# Separate created work from referenced task subjects

A transcript can quote other tasks, tools and repositories. Treat a task’s created PR and
the issue or PR it is about as separate evidence tiers. Creation claims come from the agent’s
own statement or cezar’s tool title, not arbitrary quoted tool output. A marker for the newly
created PR must not erase the original task subject.

## Consequences

A declared subject constrains resolution. Otherwise select a unique supported candidate,
using exact prompt evidence to break a tie; unresolved ambiguity yields no chip. A foreign-repo
winner requires prompt corroboration. Apply that repository veto after resolution so removing
foreign candidates cannot turn an ambiguous set into a new claim.

Repository discovery stays off the boot path. Once known, it can correct old conclusions from
retained evidence. Unknown repository identity retains the existing degraded rule rather than
inventing a repository. These rules describe attribution, not proof that a GitHub object exists.

Implementation: [store.ts](../../packages/cezar/src/runs/store.ts).

Coverage: [run-index.test.ts](../../packages/cezar/src/runs/run-index.test.ts), [store.test.ts](../../packages/cezar/src/runs/store.test.ts).
