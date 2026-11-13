---
name: check-code-quality
description: Measure complexity and CRAP for a requested JavaScript or TypeScript file, function or module, or check changed functions before a pull request merges.
---

# Check code quality

Use Squeal for both paths. Choose the path from the current task:

| Request | Path |
| --- | --- |
| Get stats for a named file, function or module | Read [Measure requested code](references/measure.md) |
| Check a PR's changed functions, beside the push, or recheck them | Read [Before a PR](references/pre-pr.md) |

A measurement request ends with the requested stats and any coverage limits.
The pre-PR path requires the complete Squeal one-shot report before the PR
merges, as its reference defines. It runs beside
the push: open the PR while the report collects, and let auto-merge wait for
it. During PR work, a measurement of selected code does not replace that
check.

The scripts in `scripts/` serve CI's complexity gate and coverage merge; read
[Bundled tool](references/tool.md) before you change them.
