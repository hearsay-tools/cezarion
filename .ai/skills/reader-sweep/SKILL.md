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

<!-- until: hearsay-tools/cezarion#2513 -->
- **An enum or discriminant value renamed** (a wait kind, outcome, status or attention
  label): the quoted old value in tests, searched before each push that renames one; the
  `test-enum-literal` baseline lists tests still on literals. A rejection test that
  passes only because the old value is now unknown must test its constraint.

  ```bash
  rg -n -F -e 'delegation.wait' -e "'ci'" packages --glob '*.test.*' --glob '*.e2e.ts'
  ```

Run `npm run test:e2e:affected` for the browser specs a change reaches
([the e2e README](../../../packages/web/e2e/README.md#choosing-specs-for-a-change)).
A change to the dry-run mocks, the turn-end rule, attention or the human-ask summary also
runs `npm run test:package` (all 13 packaged fixtures) and `npm run test:parity`.
