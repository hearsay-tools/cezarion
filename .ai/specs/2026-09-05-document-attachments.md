# Document attachments (#91)

Approved by the delegated parent on 2026-09-05. Port upstream ff9c44ed onto fork origin/main 9760978f in the existing isolated worktree.

## Design

Widen the contract's existing attachment element to image/*, application/pdf, text/plain, text/markdown and text/x-markdown. Retain images request keys, taskImages and queued images storage, and /runs/:id/images/:file URLs. Four mixed attachments per request, eight across the queued stack; each composer file is at most 5,242,880 bytes and each API encoded string is at most 7,000,000 characters. These are distinct limits.

The engine accepts private file inputs alongside existing content, persists bytes under generated names in the run's attachment directory, and passes saved absolute paths in prompt text. Only images become runner ContentBlock images. Shared persistence and hydration cover initial, live, queued/edit, deferred, continuation and restart paths. Missing/unreadable files produce a note and allow text delivery; absent inputs keep existing no-attachment behavior. No runner protocol changes.

Serving and hydration validate names and confine resolved paths to the real attachment directory, rejecting traversal, encoded separators and symlink escape. Documents are downloads with nosniff and narrow content types; images preserve viewable blocks, URLs and response behavior. Generated extensions derive from MIME, never user filenames.

Picker, paste and drop share intake rules, including upstream fallback for absent/unknown browser MIME. Documents render as named removable chips and persisted accessible links. Keep draft text on failures, keyboard operation, 44px controls, phone layout and reduced-motion feedback. Existing textarea labeling, tools, permission modes, effort controls and monitoring lifecycle remain load-bearing guard coverage. No art is needed for the existing attachment affordance.

Contract runtime helpers must survive the published package's inline-contract build. Keep @wjarka/cezarion, alias-cezarion and the fork release lineage. Do not import upstream release commits or historical execution logs.

## Verification

API and delivery regression tests prove the pre-port behavior fails. Add exact/over count and size boundaries, mixed requests, traversal/symlink cases and missing-file recovery. Run contract/route typing, harness parity and fork guard suites as part of full verification: npm run typecheck, npm test, npm run test:unit, npm run build, npm run test:package. Run browser smoke plus attachment QA at 360x640 and desktop, light/dark and reduced motion. Record acceptance-criterion outcomes in the draft PR, then handle CI and inline review. The parent evaluates merge; PR stays draft.
