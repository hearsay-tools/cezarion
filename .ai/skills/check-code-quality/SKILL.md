---
name: check-code-quality
description: Measure complexity and CRAP for a requested JavaScript or TypeScript file, function or module, or check changed functions before opening a pull request.
---

# Check code quality

Use Squeal for the local pre-PR gate and the bundled scripts for requested
statistics. Resolve `<skill>` to this directory's absolute path. Choose the path
from the current task:

| Request | Path |
| --- | --- |
| Get stats for a named file, function or module | Read [Measure requested code](references/measure.md) |
| Check a PR's changed functions, beside the push, or recheck them | Read [Before a PR](references/pre-pr.md) |

A measurement request ends with the requested stats and any coverage limits.
The pre-PR path requires the complete Squeal one-shot report, as its reference
defines, and has no bundled fallback. During PR work, a measurement of selected
code does not replace that check.

For dependency setup or a tool error, read [Bundled tool](references/tool.md).
