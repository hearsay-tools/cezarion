# Issue #201 composer actions — browser QA

Date: 2026-09-10

Result: PASS with the bounded limitations below.

## Environment

- Production build from the completed issue #201 build gate.
- Isolated disposable Git repository under `/tmp/cezar-201-qa-XFfeC0`.
- `CEZ_DRY_RUN=1`, fixture-owned `CEZ_HOME`, `CEZ_SKILLS_AUTO_UPDATE=0`, and `CEZ_HANDOFF_FILE` explicitly unset.
- agent-browser 0.36.0 / Chrome for Testing 151, with `TMPDIR=/tmp` and `AGENT_BROWSER_ARGS=--no-sandbox`.
- Desktop 1440×900 and mobile 360×640; explicit light and dark preferences; reduced-motion emulation.

## Automated real-browser evidence

- `env -u CEZ_HANDOFF_FILE TMPDIR=/tmp AGENT_BROWSER_ARGS=--no-sandbox npx vitest run --config packages/web/e2e/vitest.config.ts composer.e2e.ts`: 8/8 passed. Log: `/tmp/cezar-201-composer-e2e.log`.
- `env -u CEZ_HANDOFF_FILE TMPDIR=/tmp AGENT_BROWSER_ARGS=--no-sandbox npx vitest run --config packages/web/e2e/vitest.config.ts task-thread.e2e.ts`: 24/24 passed.
- The first combined run found one stale e2e expectation (`Continue` with selected content); after the controller updated it to the approved `Send` behavior, the task-thread rerun passed.
- E2E artifacts also cover attachment selection/removal and preservation, live waiting reply delivery, closed-session continuation, and removal of duplicate header actions.

## Manual observations and acceptance mapping

- Waiting, empty: disabled primary Send plus enabled secondary Stop. Enter while the empty textarea was focused left the run waiting and did not stop it.
- Waiting, content: Send became enabled and Stop remained available. Clearing the textarea restored the empty action state.
- Stopping: immediately after Stop, the DOM showed disabled `Stopping…`, disabled Send, disabled attachment control, and the exact draft remained in the textarea. The dry-run termination completed before a screenshot command could capture that transient frame.
- Stopped/terminal with content: the draft survived confirmed cancellation and the primary action was Send. With an empty composer after reload, the primary action was Continue.
- Failed Stop: a one-shot browser-level fetch failure produced `cannot reach the cezar server (...)`, explained that the draft was kept, restored enabled Stop and Send controls, and retained the exact draft in the live DOM. Retrying Stop succeeded and the draft remained after termination.
- Headers contained neither Continue nor Cancel actions; task control remained in the shared composer.
- At 360×640, visible composer action targets measured 44×44 px and document horizontal overflow measured 0 px. The same state changes remained stable at 1440×900.
- Light and dark preferences both rendered readable composer controls. Reduced-motion emulation was active during the mobile draft/Stop path.
- Provider/account hint and identity-selection preservation are covered by focused component tests; the manual pass did not change a real account because the fixture exposes mock/local identities.

## Limitations

- The dry-run backend moved queued runs to waiting faster than a navigation plus screenshot could capture an honest queued frame, even when fixture concurrency was reduced. Stopped-before-start requeue, same task identity, duplicate prevention, restart/capacity, and original inputs/attachments are therefore attributed to the focused engine regression tests rather than claimed as manual screenshots.
- The same fast termination prevented a screenshot of the transient stopping state. The disabled stopping controls and retained draft were read from the live DOM before terminal reconciliation; the terminal screenshot is labeled separately.
- No real provider credentials or remote agent conversations were used.

## Screenshots

- `assets/201/waiting-empty-desktop-dark.png`
- `assets/201/waiting-empty-desktop-dark-2.png`
- `assets/201/waiting-empty-mobile-light.png`
- `assets/201/waiting-draft-mobile-dark-reduced.png`
- `assets/201/stopped-draft-mobile-dark-reduced.png`
- `assets/201/stopped-empty-mobile-light.png`
- `assets/201/stopped-empty-desktop-light.png`
- `assets/201/terminal-draft-desktop-dark.png`
