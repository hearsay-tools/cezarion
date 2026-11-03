---
name: reader-sweep
description: Before you rename, move or remove a shared name, value or default (a RunRecord field, an enum or discriminant value, a seeded default, a cockpit control, visible copy, dry-run turn-end behavior), find and update every reader.
---

# Reader sweep

A change to a shared name, value or default needs a **reader sweep**: find every reader
of the thing you changed — code, unit tests, browser specs, packaged fixtures, messages
that name it — and update each one, or state in the plan or PR why it stays. Search for
the old and the new form, because a reader can assert that something is present or that
it is absent. Inspect every match: common names match unrelated text, and compatibility
names, intentional refusal tests, legacy-row conversion tests and historical references
stay. The general construction-site rule in the [load-bearing-change skill](../load-bearing-change/SKILL.md) covers shared in-memory objects, and
the Task routing rows for run search, pending asks and skills list their readers.

Where readers hide, searched from the repo root (replace the example values):

<!-- until: hearsay-tools/cezarion#2512 -->
- **A `RunRecord` field renamed, moved or removed**: packaged and browser fixtures, by
  its old and new names or paths, searched as below; a unit
  test using `makeRunRecord` fails to compile instead.

<!-- until: hearsay-tools/cezarion#2513 -->
- **An enum or discriminant value renamed** (a wait kind, outcome, status or attention
  label): the quoted old value in tests, searched before each push that renames one; the
  `test-enum-literal` baseline lists tests still on literals. A rejection test that
  passes only because the old value is now unknown must test its constraint.

  ```bash
  rg -n -F -e 'delegation.wait' -e "'ci'" packages --glob '*.test.*' --glob '*.e2e.ts'
  ```

<!-- until: hearsay-tools/cezarion#2510 -->
- **A default removed** (a catalog, a source or a seeded entry): browser specs, by its
  entry names, source names and the `data-slot` of each list or view that renders those
  entries — a spec can depend on how many entries a list holds without naming any of
  them. A spec that counts, lists or scrolls the default's entries must seed its own, as
  [the e2e README](../../../packages/web/e2e/README.md#seed-the-catalog-entries-a-spec-relies-on)
  says.

  ```bash
  rg -l -F -e 'open-mercato/skills' -e 'skill-row' packages/web/e2e/*.e2e.ts
  ```

<!-- until: hearsay-tools/cezarion#2514 -->
- **Cockpit source changed**: the browser specs that run the changed file.
  `npm run test:e2e:affected -- --plan` lists them from the spec map
  ([the e2e README](../../../packages/web/e2e/README.md#choosing-specs-for-a-change)); without
  `--plan` it runs them. When it reports no spec map, search the specs for the
  `data-slot`, `data-streamdown` and `data-testid` values and class names that the file
  and the local components it imports render. Walk down to what the file renders, never
  up: going up reaches most of the suite. One edit to a shared renderer can reach specs
  of other features.

  ```bash
  grep -lE 'link-safety|data-streamdown|thread-markdown' packages/web/e2e/*.e2e.ts
  ```

<!-- until: hearsay-tools/cezarion#2514 -->
- **Visible copy added, renamed or removed** (a label, a tab, a heading, a button, an
  empty state): browser specs, by the new and the old string; the attribute search does
  not find text assertions.

  ```bash
  grep -lF 'Automations' packages/web/e2e/*.e2e.ts
  ```

<!-- until: hearsay-tools/cezarion#2514 -->
- **Dry-run turn-end behavior changed** — the `packages/cezar/scripts/mock-*.mjs` mocks,
  the turn-end rule, attention, or the human-ask summary: the browser and packaged
  fixtures that drive a dry-run task to a park. A
  `mock-*.mjs` edit counts when it changes the frames that an existing `mock:<scenario>`
  sends, or where that scenario's turn ends, for the configuration a runner sends at
  shipped defaults. A new scenario does not count, and neither does a branch that the
  shipped configuration never reaches, such as one for a misconfigured runner or for a
  configuration no runner sends yet. When a mock edit does
  not count, the PR's Verification section says why.

  ```bash
  P="waitForStatus\([^)]*'waiting'|hasPendingHumanAsk|attentionLabel|'mock:"
  grep -lE "$P" packages/web/e2e/*.e2e.ts packages/cezar/test/e2e/*.test.ts
  ```

Require passing results for the specs and fixtures the sweep selects. Read browser specs
through Squeal (`squeal status --wait 60000 <files>`, then `squeal run --slow --wait 60000`
if slow results are not current), or without it run `npm run test:e2e -- <specs>` (one
call takes several specs). Run packaged fixtures with `npm run test:package -- <repo-root paths>`
([validation skill](../validation/SKILL.md) → *Packaged CLI E2E runs by hand*). Dry-run park fixtures also need the
unit parity suites in
[Runner regressions ship with shared coverage](../../../docs/areas/runners.md#runner-regressions-ship-with-shared-coverage).
