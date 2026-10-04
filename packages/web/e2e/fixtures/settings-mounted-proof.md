# Settings control readiness regression (#795)

Run serially from the repository root after `npm ci` and `sh .ai/scripts/test-env-up.sh`:

```
node --import tsx packages/web/e2e/fixtures/settings-mounted-proof.ts
npm run test:e2e -- settings-agents.e2e.ts
```

The fixture borrows that worktree's real dry-run server and owns a native browser session. It restores its prompt and branch configuration, releases held responses, detaches CDP and closes the session on completion. Stop the borrowed environment with `sh .ai/scripts/test-env-down.sh` when finished.

The form mounts after config loads. Its branch select mounts separately when the repo query returns git information. The real `AgentsForm` save-mutation success path updates config and invalidates repo; it does not clear warm repo data. The component guards exercise both cases: a prompt save completes while a cold repo response remains held and the select is absent; a warm refetch retains the select. Guards also retain the unavailable repository state and the empty branch answer.

The native fixture registers a fetch wrapper before navigation using CDP and retains that attachment through navigation. It holds the **actual server response**, after recording that it contains real git information and branches, through the original prompt edit/save and successful config readback. It neither supplies response data nor alters React's DOM.

For the branch read, a wrapper returns the actual native `document.querySelector` result unchanged. Its first real null result schedules a controlled `queueMicrotask` releasing the held HTTP response. The unguarded original expression throws `null.options` before that response can mount the select. With `waitForSettingsControl`, the first predicate sees null, the response mounts the real control, and the unchanged expression and nonempty assertion succeed. The fixture then performs the original native value-setter/change actions and verifies persisted branch selection and clearing through the server.

Readiness uses the existing bounded `waitForFunction`: mounted target, enabled target for actions, and committed select options. It checks only that the default option exists, not that a real branch exists or any desired value is selected. A select with only its empty default option proceeds to the original nonempty assertion and fails there. Reads may explicitly permit disabled controls. A finished unavailable state never fabricates a select and cannot pass the gate. No timeout, hold, skip, assertion, idle policy or driver action changes.

This is a controlled ordering regression. The historical failure bundle proves the original read saw null and a later capture showed the control. It has no HTTP timing trace; a still-pending cold repo query is a source-supported explanation, not a claim about the exact historical request schedule.

## Affected-site audit

The audit covers every e2e file referring to settings, all direct settings property reads and native setters, and the corresponding component query/mount boundaries.

| Sites | Boundary and disposition |
| --- | --- |
| `settings-agents`: base-branch options read, selection and clearing | Independently loaded repo control; explicit target gate before read and intrinsic setter gate. Original branch and persistence assertions retained. |
| `settings-agents`: model setter; runner Codex and cleanup Claude clicks | Provider status independently enables these controls. Intrinsic select gate and target enabled gate before the original native clicks; existing pending/disconnected component guards retained. |
| `settings-agents`: prompt setter; cold model/prompt property reads | Setter has intrinsic mounted/enabled gate; property reads use mounted/options gate permitting disabled controls. Original input and expected values retained. |
| `settings-resources` / `settings-monitoring` | Worktrees/Resources sections mount with their config forms. Setters already wait for enabled targets; the wake field is conditional on local mode in that same form and has an explicit target wait before edit. Cold reads mount with the saved config. No independently loaded unguarded control found. |
| `composer-defaults` Resources setter | Its `resources-composer-defaults` target wait mounts the same config form and select atomically; one action after navigation. No independent target mount. |
| `settings-agent-config`, `settings-skills`, `skills-update` | Async catalog/list/detail work uses target-specific waits before dependent reads or actions. No matching unguarded conditional control found. |
| `settings-bookmarklets`, webhook settings in `task-handoff` | Imperatively generated href uses its own href wait; filter reads follow native attachment actions. Webhook values use bounded target-value waits. No matching site found. |
| `settings-sidebar`, navigation/project/menu specs, `ios-sweep` | Shell/navigation targets have their own waits; no unguarded independently loaded settings form property/action found. The iOS runner task failure is a separate parent-owned diagnosis. |
| `settings-appearance`, `worker-relationships`, other appearance setup | Previously reviewed appearance readiness remains unchanged. |
| Accounts, notifications, projects, prompt-template settings | No matching direct mounted-control e2e read/setter in the existing specs. No changes. |

To prove the regression, retain all component/native guards and the spec edits, replace only `waitForSettingsControl`'s body with a no-op, and run the native fixture: it must fail on the original `null.options` access. Restore the helper and repeat: it must pass the original branch/config assertions. Keep diagnostic logs under ignored `.ai/qa/`; they are not source files.
