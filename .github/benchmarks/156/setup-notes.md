# Setup experiment notes — issue #156

Baseline: `b1fe75911378dfe7816a7a83312c2acbdcf848f4`

## Patch scope

`setup.patch` adds only the file-level `// @vitest-environment node` annotation to 44 web test files. It changes no test body, production source, Vitest configuration, shared setup, lifecycle assertion, server setup, or `packages/cezar/vitest.setup.ts`.

The selected suites exercise pure transforms, policies, parsers, reducers, static source inspection, and build configuration. Their imported modules have no runtime DOM dependency on the exercised path. Browser-bound suites remain in jsdom, including React render/hook tests and tests that exercise storage, document/window state, WebSocket/EventSource, Notification, File, layout, focus, keyboard DOM events, or other browser constructors.

Files:

- `packages/web/src/api/contract-pipeline.test.ts`
- `packages/web/src/api/events.test.ts`
- `packages/web/src/components/composer/composer-text.test.ts`
- `packages/web/src/components/diff/diff-scroll.test.ts`
- `packages/web/src/components/diff/parse-patch.test.ts`
- `packages/web/src/components/diff/word-diff.test.ts`
- `packages/web/src/components/nav-items.test.ts`
- `packages/web/src/design-guardian.test.ts`
- `packages/web/src/lib/attention.test.ts`
- `packages/web/src/lib/bookmarklet.test.ts`
- `packages/web/src/lib/format.test.ts`
- `packages/web/src/lib/git-actions.test.ts`
- `packages/web/src/lib/github-task.test.ts`
- `packages/web/src/lib/global-tasks.test.ts`
- `packages/web/src/lib/highlighter.test.ts`
- `packages/web/src/lib/project-tags.test.ts`
- `packages/web/src/lib/prompt-templates.test.ts`
- `packages/web/src/lib/provider-auth-alert.test.ts`
- `packages/web/src/lib/provider-status.test.ts`
- `packages/web/src/lib/read-state.test.ts`
- `packages/web/src/lib/skills.test.ts`
- `packages/web/src/lib/task-columns.test.ts`
- `packages/web/src/lib/task-groups.test.ts`
- `packages/web/src/lib/tasks-table.test.ts`
- `packages/web/src/lib/token-metrics.test.ts`
- `packages/web/src/lib/unified-diff.test.ts`
- `packages/web/src/lib/use-submit-shortcut.test.ts`
- `packages/web/src/lib/utils.test.ts`
- `packages/web/src/lib/workflow-builder.test.ts`
- `packages/web/src/routes/github/github-filter.test.ts`
- `packages/web/src/routes/new-task-autostart.test.ts`
- `packages/web/src/routes/new-task-form.test.ts`
- `packages/web/src/routes/new-task-params.test.ts`
- `packages/web/src/routes/new-task-plan.test.ts`
- `packages/web/src/routes/settings/agent-descriptors.test.ts`
- `packages/web/src/routes/task-git/file-tree.test.ts`
- `packages/web/src/routes/task-git/worktree-files.test.ts`
- `packages/web/src/routes/task-thread/active-provider.test.ts`
- `packages/web/src/routes/task-thread/run-actions.test.ts`
- `packages/web/src/routes/task-thread/subagent-dock.test.ts`
- `packages/web/src/routes/task-thread/thread-groups.test.ts`
- `packages/web/src/routes/task-thread/thread-scroll.test.ts`
- `packages/web/src/routes/task-thread/thread-state.test.ts`
- `packages/web/src/vite-config.test.ts`

## Local correctness

The baseline was expanded from `git archive` into `/tmp/cezar-156-setup.1mlZ27`; the existing root `node_modules` was symlinked into that archive only. No application source in the shared worktree was modified.

The exact 44 annotated suites passed together:

```text
Test Files  44 passed (44)
Tests       1167 passed (1167)
Duration    2.35s
```

A broader web run also completed every selected suite successfully. Its only failures were the two existing `fixture-serve-env.test.ts` path-boundary cases caused by running an archived copy under `/tmp` while resolving the shared worktree installation; that file already has its own Node annotation and is absent from this patch. The authoritative root baseline gate was run separately with a clean `TMPDIR`.

Patch validation: `git apply --check .github/benchmarks/156/setup.patch` passes against the fixed baseline. The patch contains 44 files and exactly 88 added lines.

## Read-only harness review

1. The initial workflow's verified archive command included `packages/contract/dist`. A completed baseline build produces `packages/cezar/dist` and `packages/cezar/web/dist`; the cezar postbuild inlines the contract, and `packages/contract/dist` is absent. That `tar` invocation would fail before uploading `verified-<repetition>`, then all snapshot-reuse jobs would fail to download it. Reported to the parent for correction.
2. Archive creation, artifact upload/download, and extraction are outside `measure.py`. The parent confirmed those setup costs will be retained from the GitHub jobs API when calculating total runner/setup time.
3. The initial unit tests exercised a failed `run_step` and verified persisted evidence, but did not invoke the collector entry point to prove its process exit status follows the failing command. Reported to the parent, who added the CLI failure test.
4. The workflow correctly checks out the harness and fixed application separately, uses pinned action revisions and Node 24.20.0 on `ubuntu-24.04`, keeps matrix failures independent, and uploads raw JSON/log/time files under `always()`. The collector uses argument arrays, records GNU time wall/user/system/RSS values and command exit codes, stores the baseline and patch identities, and uses a private per-job npm cache.

