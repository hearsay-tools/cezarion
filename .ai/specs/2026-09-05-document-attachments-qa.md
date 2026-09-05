# Document attachment QA (#91)

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| PDF, TXT, Markdown on tasks and follow-ups | PASS | Real browser picker submitted four mixed files; persisted task and live follow-up links; API tests cover all four routes. |
| Queued messages, continuation and restart | PASS | Engine tests cover initial/stacked hydration, queued restart continuation with mixed files, deferred flush, live and reopened sessions. |
| Saved document paths; viewable images | PASS | Mock runner stdin contains saved PDF paths, one mixed image block, no PDF bytes; downloaded PDF matches original bytes. |
| MIME, count, size and confinement | PASS | Every request route accepts four mixed files and rejects five; encoded 7,000,000 accepted and 7,000,001 rejected for PDF and PNG. Composer tests cover 5,242,880/5,242,881 bytes for all types. Traversal and file/directory symlink requests rejected. |
| Keyboard, 44px targets and phone themes | PASS | Keyboard removal via focus + Enter; picker measured 44x44, chips 48px high, persisted links 44px high; inspected 360x640 dark/light and 1280x800 light; no horizontal page overflow. |
| Failure retains draft; chips and links accessible | PASS | Aborted browser message request shows error and restores text plus PDF chips under reduced motion. File-read rejection unit test preserves draft and reports filename. |
| Contract, recovery, package and manual QA | PASS | Typecheck; 6,682 Vitest tests; unit suites; build/check-pack; 22 package tests including runtime document vocabulary in inline contract. |

No artwork: existing paperclip is the entry point. Reduced-motion media emulation was verified through matchMedia; error and upload feedback remain visible. Fork textarea label, effort/permission controls and monitoring logic are preserved. Missing/unreadable documents and failed persistence produce visible notes; an empty failed-document message receives explanatory text rather than an empty runner payload.

## Regression proof

Before port: 6 of 11 upstream API regressions failed (documents 400 and missing download headers); five image/validation guards passed. Before confinement: four new traversal/symlink cases failed. Before review fixes: unreadable-document and persistence-failure tests failed. Removing the same-process missing-file note makes its regression fail; restoration passes.

## Verification limitations outside this port

The optional full browser suite finished with 189 passed, 22 failed and 6 skipped. A detached checkout of unchanged 9760978f reproduced 21 failures: stale quick-list/task-thread expectations, project-specific GitHub visibility, paginated thread history, queued-edit timing, collapsed agents dock, extra settings sections/runners, discovered model selection, navigation timing, and diff virtualization on a dirty tree. Monitoring's remaining failure is a disabled-control race: the test waits for server persistence, then fills/saves before the capacity mutation finishes in the browser. A delayed capacity response reproduces the same race on baseline; the unmodified monitoring test passes against the clean current-port QA server (1 test, 1.83s). No attachment change touches those surfaces. These failures are recorded, not relabeled as passes or weakened.

The browser provisioning command reported skipped because agent-browser doctor cannot launch under the container sandbox or reach the Chrome CDN. The installed browser was verified against the live local cockpit using TMPDIR=/tmp and AGENT_BROWSER_ARGS=--no-sandbox; the full suite and manual QA then ran directly with that provider. Native doctor was not treated as successful.

The final package run initially hit registry timeouts; retry with npm fetch retries disabled and a 20-second fetch timeout passed all 22 tests. The earlier full package run also passed.

Local evidence: /tmp/cez91-{mobile-dark-final,mobile-light,desktop-light,upload-error}.png; /tmp/cez91-{final-type,final-vitest,final-unit,final-build,package-retry,browser-suite}.log; /tmp/cez91-baseline-*.log. Screenshots are local QA artifacts, not published application assets.

## PR #101 review round 1

Both inline findings reproduced before their fixes: a failed document-only queue enqueue/edit lost its durable prompt, and a fresh Continue upload had no durable pre-spawn payload. Regression tests now cover disk-reopened queue fallback plus immediate, capacity-wait, running-step and missing-document Continue recovery, preserving exact URLs, document bytes and one viewable image without duplicate files. Independent review additionally caught and verified fresh-image viewability on write failure and same-backend account-switch affinity across immediate and queued recovery (named/default accounts). Each new guard failed before its fix. A completed opening turn clears the checkpoint; errors and cancellation retain it.

The effort-override unit fixture now explicitly completes its stubbed first continuation before requesting another: accepting Continue synchronously persists running state, so a second request while still running correctly refuses. The effort preservation and override assertions remain unchanged. Browser QA above remains applicable: review fixes change server persistence/recovery only.

Final review-round verification: typecheck, all 6,682 Vitest tests, unit suites, build/check-pack (496 files, 84 web assets), and all 22 package tests passed. Logs: /tmp/cez91-review-final-{type,vitest,unit,build,package}.log.
