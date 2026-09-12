# Real API verification supplement

The six reusable QA scripts were copied unchanged from parent commit `d94958cc`. The old source-confirmation hold in that README is superseded by the user's explicit confirmation of SHA256 `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`, verified again before this run. Application source and build are unchanged from `c6d56857`.

Started the isolated built service on port **44633**, browser wrapper session **skills-e933-real**. The launcher passes only PATH and explicit isolated vendor/CEZ settings; no inherited credentials. The capture script launches its own separate Chromium context. No browser response interception is installed. Only the isolated fixture workflow is created, overwritten and deleted; no skill installation, external agent, GitHub operation or automation is launched.

`server-proof.json` proves the live process entry, repository identity, served index, and all **93 JS/CSS/font assets** match this worktree's build. `fixture-proof.json` records four Zod-validated runs and their parent/worker relationship. `proof.json` records ten screenshots, actual mutation HTTP statuses and the behavioral checks. The import parser returned a real 400; initial save and overwrite returned 201, repeated save returned 409, and cleanup deletion returned 200. The persisted YAML retained an explicit prompt on a skill-referencing step and the reordered command-first sequence; reload confirmed the saved steps.

These ten screenshots supplement the existing 74 design-oriented captures. They use real discovered skills and the seeded three-step `fixture-review` workflow, so content, row counts, and some viewport heights differ from the corresponding design frames. The `reference` entries identify related frames, **not exact pixel-comparison pairs**. They do not replace the matched-fixture ledger or establish visual parity. `overview.jpg` was visually inspected: both themes render populated desktop/mobile content; import error and overwrite controls remain visible; long local paths wrap. The overwrite screenshot also includes real save/import notifications. Shared shell width, typography, glyphs, and the residual differences in the parent `REVIEW.md` remain outstanding.

Reproduce after building:

```sh
node .ai/qa/runtime-verified/serve-fixture.mjs "$PWD" 44633
# In a second terminal:
RUNTIME_BROWSER_SESSION=skills-e933-real .ai/qa/runtime-verified/browser.sh open http://127.0.0.1:44633/p/default/skills
RUNTIME_BROWSER_SESSION=skills-e933-real node .ai/qa/runtime-verified/verify-proof.mjs
node .ai/qa/runtime-verified/verify-fixture.mjs
env -u TMP -u TEMP TMPDIR=/tmp \
  CEZ_QA_PLAYWRIGHT=/tmp/cez160-webkit/node_modules/playwright/index.mjs \
  CEZ_QA_CHROMIUM=/home/agent/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  node .ai/design-reference/iteration-3/skills-workflows/real-runtime/capture.mjs
```

The browser dependency paths are environment-specific; substitute installed Playwright and Chromium paths elsewhere. Stop only the service PID recorded by this fixture after validating its command. Runtime home/vendor directories are excluded from this evidence commit.
