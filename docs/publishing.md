# Publishing — stable releases and npm previews

## Package identity

This repository publishes as **`cezarion`** — chosen for this clone in #23, and
confirmed free on the registry before the first release. Two names reach npm:

| What a user types | Package | Why |
|---|---|---|
| `npx cezarion` | `cezarion` (unscoped alias, `alias-cezarion/`) | the install line every doc quotes |
| `npm i @wjarka/cezarion` | `@wjarka/cezarion` (`packages/cezar`) | the implementation, under a personal scope |

Installed bins are **`cezarion`** and **`cez`**. Upstream's `cezar` and
`cezar-cli` bins are deliberately **not** published here, so a global install of
this clone can never shadow the upstream tool. The product keeps its name inside
the repo — `.ai/cezar/`, `~/.cezar/`, `CEZ_*` and the `cez` command are
unchanged — and the private workspace packages keep their `@open-mercato/*`
names because they never reach npm.

How cezar reaches npm. Two paths, deliberately separate
(spec: `.ai/specs/2026-07-18-npm-preview-publish.md`, issue #482), with
two authentication methods (#33):

- **Stable releases** (`latest`) are **owner-driven and manual**: a maintainer
  runs the [`Release`](../.github/workflows/release.yml) workflow from the
  Actions tab (`workflow_dispatch`) and picks the version bump. CI never moves
  `latest` — a push to `main` publishes nothing. The workflow splits **Verify**
  (typecheck, tests, build) from **Release** (publish): a registry blip after a
  green suite fails only the publish job, so the Vitest Actions report stays a
  single green summary (#62). The publish job authenticates with **npm trusted
  publishing** (OIDC): no `NPM_TOKEN` in the job, provenance attached
  automatically.
- **Previews** are **CI-driven**: the `publish-snapshot` job in
  [`ci.yml`](../.github/workflows/ci.yml) publishes a snapshot of every package
  after a fully green `verify` run — on `develop` pushes and same-repo PRs only.
  Authenticated with `NPM_TOKEN`.
- **Nightlies** are **clock-driven**: [`nightly.yml`](../.github/workflows/nightly.yml)
  cuts `main`'s tip every night under the `nightly` dist-tag, so `npx cezarion@nightly`
  is always the trunk. Also runnable on demand from the Actions tab.
  Authenticated with `NPM_TOKEN`.

| Channel | Workflow | Authentication | Provenance |
|---|---|---|---|
| `latest` (stable) | `release.yml` (`production`) | OIDC trusted publisher — no npm credential in the job | automatic (do not pass `--provenance`) |
| `pr-<N>`, `develop` | `ci.yml` `publish-snapshot` | `NPM_TOKEN` | `--provenance` |
| `nightly` | `nightly.yml` | `NPM_TOKEN` | `--provenance` |
| drop `pr-<N>` dist-tag | `npm-preview-cleanup.yml` | `NPM_TOKEN` (`npm dist-tag rm`; OIDC does not cover this command) | n/a |

npm allows **one trusted publisher per package**. This repository publishes two
packages from three workflows, so only the stable path is OIDC. Collapsing the
three publish jobs into one reusable workflow would not lift that ceiling:
npm validates the *calling* workflow filename (`job_workflow_ref`), not the
called one.

Every workspace manifest is in the release, always at the same version; two of
them ship:

| Package | Ships? | What it is |
|---|---|---|
| `@open-mercato/cezar-contract` | **no — `private`** | the HTTP contract schemas (`packages/contract`) |
| `@open-mercato/cezar-api-client` | **no — `private`** | the typed client (`packages/api-client`) |
| `@wjarka/cezarion` | yes | the service + CLI, ships the built cockpit (`packages/cezar`) |
| `@open-mercato/cezar-web` | **no — `private`** | the cockpit SPA (`packages/web`) |
| `cezarion` | yes | the unscoped bin alias, so `npx cezarion` works (`alias-cezarion`) |

The publishable rows are also the **publish order**, and it is load-bearing: each
package depends on the one above it, so publishing a dependent first would briefly
advertise a version of its dependency that is not on the registry yet. The
workspace root itself is `private` and is not in the release at all.

**Private ≠ excluded.** A private package is stamped like everything else — its
version moves in lockstep and every pin against it is rewritten — it is
simply never handed to npm. Leaving one behind is what made a version-bump
commit fail `npm ci` (#35): consumers demanded `^<new>` while the unstamped
manifest still said `<old>`, so npm fell through to the registry and missed.

The api-client is consumed inside the workspace (the cockpit bundles it from
source, the service's tests import it) and stays unpublished until its surface
stops moving: it still carries the hand-written DTOs, which shrink family by
family as routes are converted, so publishing now would advertise a contract
that changes materially every release. Publishing a private package is one
line — delete `"private": true` from its manifest; the release code reads npm's
own flag and needs no change. A newly public name still needs a first token
publish (trusted publishers are configured on an existing package) and then
its own trusted-publisher row plus a token grant — see the admin setup below.

## Stable releases

Run **Actions → Release → Run workflow** from `main` and choose a bump:

| Bump | Effect (base `0.1.5`) |
|---|---|
| `patch` | `0.1.6` |
| `minor` | `0.2.0` |
| `major` | `1.0.0` |
| `existing` | publishes the version already committed to `packages/cezar/package.json` |

The workflow verifies, builds, then `scripts/release.mjs` stamps every manifest
(intra-release dependencies keep a **caret** range — stable follows compatible
releases, unlike the exact-pinned snapshots), publishes them in dependency order
with `--tag latest` (no `--provenance` — trusted publishing attaches it), opens
a version-bump PR, and cuts a GitHub Release tagged `v<version>` at the published
source commit. The bump PR targets the dispatched branch (`main` or a
`release/*` maintenance branch); the workflow never pushes to that branch. It's
gated behind the `production` environment, so a release can require reviewer
approval — and the
trusted publisher on npmjs.com is pinned to that same environment name. Outside
Actions, with neither `NODE_AUTH_TOKEN` nor the OIDC request env, the script
degrades to a loud dry run.

### Retrying an interrupted release

Publication, the version-bump PR, and the GitHub Release have separate outcomes
in the workflow summary. A failed bump PR leaves the job failed and visible, but
does not prevent GitHub Release finalization after successful npm publication.
The summary confirms the tag only after resolving it to the published source
commit; npm success alone does not prove that a tag or Release exists.

Retry the release job from the **same source commit and bump input**. Packages
already published at that version count as successful publication. For
patch/minor/major releases, finalization regenerates the lockfile and compares the
expected full tree and source parent with `release/v<version>`. A matching branch
keeps its original commit, even if the retry would create a different commit
timestamp. A matching open or merged PR is reused; a deleted branch belonging to
a matching merged PR stays deleted. A matching GitHub Release and source tag are
also reused. The `existing` input needs no bump PR.

Conflicting branch contents, a different source parent, a closed unmerged PR, or
a different release/tag produce an error with a recovery link. No existing remote
work is overwritten. Inspect the linked comparison or Release and resolve the
mismatch manually before retrying; do not delete or force-push another person's
work to make a retry pass.

If PR creation reports **“GitHub Actions is not permitted to create or approve
pull requests”**, an administrator must enable **Settings → Actions → General →
Workflow permissions → Allow GitHub Actions to create and approve pull requests**.
The job also needs `pull-requests: write`, which this workflow already declares.
An organization or enterprise policy may prevent enabling the repository setting;
ask that administrator to allow it, or open the PR manually using the comparison
link printed in the error. Repository default workflow permissions can remain
read-only. See [GitHub's permission documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

For the interrupted `0.12.1` release in issue #192, the original branch is
[`release/v0.12.1`](https://github.com/hearsay-tools/cezarion/tree/release/v0.12.1).
[Open its bump PR against main](https://github.com/hearsay-tools/cezarion/compare/main...release%2Fv0.12.1?expand=1)
if the permission remains disabled. Opening that PR does not create the GitHub
Release: check the Release and tag outcomes separately.

**[Re-runs retain their original source commit](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).**
Re-running run `34386025582` will not pick up this fix after it merges. Do not dispatch a new patch from a
newer source merely to recover that publication: it may reuse a published version
for different code. For that historical run, recover the PR through the link
above and have a maintainer create or verify `v0.12.1` and its GitHub Release at
the original published source `d9d3c542fdd0fa06ded6089656513ee5c5090eaf`, listing
`@wjarka/cezarion@0.12.1` and `cezarion@0.12.1`. Inspect any existing tag or Release
before creating it. Subsequent runs using the fixed workflow support retries as
described above.

## Nightlies

Every night at **03:17 UTC**, [`nightly.yml`](../.github/workflows/nightly.yml)
verifies `main` (typecheck, unit suites, build, packaged-CLI e2e — the same gate
a release runs) and publishes it under the `nightly` dist-tag:

```bash
npx cezarion@nightly              # whatever is on main as of last night
npx cezarion@0.1.5-nightly.20260813.126   # that exact night, forever
```

The version is named after the **day it was cut** — `<base>-nightly.<YYYYMMDD>.<run_number>`
— so the version list reads as a calendar and a user can tell how old their build
is without looking anything up. The run number trails the date so an on-demand cut
never collides with the scheduled one; both are numeric semver identifiers, so the
ordering stays chronological.

**Manual runs:** Actions → Nightly → *Run workflow* (from `main`). It publishes
immediately, even if nothing has merged since the last one — that's what the
`force` input defaults to. A *scheduled* run skips itself when `main` has not moved
in 24 hours, because that build is already the one tagged `nightly`.

The channel is requested **by name** (`CEZ_RELEASE_CHANNEL=nightly`), never inferred
from the event, so no other workflow's manual dispatch can cut a nightly by accident;
`computeSnapshot` additionally re-checks that the ref is `main`. Nightlies are
prereleases under an explicit dist-tag like every other snapshot — they can never
become the default install.

## Preview channels

| Event | Version (example) | dist-tag | Install |
|---|---|---|---|
| same-repo PR, CI green | `0.1.5-pr482.123` | `pr-482` | `npx cezarion@0.1.5-pr482.123` |
| push to `develop` | `0.1.5-develop.124` | `develop` | `npx cezarion@develop` |
| nightly cut of `main` | `0.1.5-nightly.20260813.126` | `nightly` | `npx cezarion@nightly` |

A push to `main` publishes **nothing**: the trunk reaches npm through the nightly
above, or through an owner-driven stable release — never straight off a merge.

Version scheme: `<base>-<channel>.<run_number>`, with `.<run_attempt>` appended
on re-runs so no publish ever collides. Prerelease versions under explicit
dist-tags are invisible to a plain `npx cezarion`, which keeps resolving
`latest`.

Every package publishes in lockstep, in dependency order, with each intra-release
dependency **pinned to the exact snapshot version** — so a preview always runs
exactly the code it was built from. Names are read from the checked-out manifests
at publish time, never hardcoded, and the pin is rewritten in whichever dependency
section declares it, so moving a dependency between `dependencies` and
`devDependencies` needs no change here.

On every PR snapshot the job upserts one sticky comment (marker
`<!-- cezar-npm-preview -->`) with the exact copy-pasteable commands. When a PR
closes, [`npm-preview-cleanup.yml`](../.github/workflows/npm-preview-cleanup.yml)
best-effort removes its `pr-<N>` dist-tag from every package (the versions
themselves stay — npm allows unpublish only within 72 hours, and untagged
prereleases are inert).

## Pieces

| Piece | Role |
|---|---|
| `packages/cezar/src/release/snapshot.ts` | pure decisions: channel/version/dist-tag, install lines (unit-tested) |
| `packages/cezar/src/release/manifests.ts` | the shared stamper: which manifests exist, and how each pins the next (unit-tested) |
| `scripts/release.mjs` | stable orchestrator: stamps manifests, `npm publish --tag latest` via OIDC, no `--provenance` (e2e-tested) |
| `scripts/release-snapshot.mjs` | snapshot orchestrator: stamps manifests, `npm publish --tag <channel> --provenance` with `NPM_TOKEN`, emits result JSON (`--dry-run` supported; e2e-tested) |
| `ci.yml` → `publish-snapshot` | gate (`needs: verify`), same-repo guard, provenance permissions, sticky PR comment, step summary |
| `nightly.yml` | the 03:17 UTC cron + manual dispatch: main-only guard, "did main move?" check, full verify, then the same orchestrator with `CEZ_RELEASE_CHANNEL=nightly` |
| `npm-preview-cleanup.yml` | dist-tag removal on PR close |

Guards: the job runs only for pushes and same-repo PRs (fork PRs get no
secrets, and `computeSnapshot` re-checks the head repo as defense in depth);
the dist-tag is always explicit so a snapshot can never become `latest`;
concurrency is non-cancellable so a publish never stops part-way through the
set (and if it ever did, the alias — published last — is the one users install,
so its tag only moves once everything below it is on the registry). **Without the `NPM_TOKEN` secret a snapshot or nightly degrades to a loud dry
run and stays green** — those jobs still need the token (OIDC is only configured
for `release.yml`). A stable release with no trusted publisher fails, it does
not dry-run.

## One-time admin setup

On **npmjs.com**, signed in as the account that owns the `@wjarka` scope:

1. Both published names already exist (`v0.11.0` created them). A user scope
   belongs to the npm account of the same name, so `@wjarka/*` needs no org
   and no team setup.
2. For **each** of `@wjarka/cezarion` and `cezarion`: Settings → *Trusted
   Publisher* → GitHub Actions, then:
   - Organization or user: `wjarka`
   - Repository: `cezar`
   - Workflow filename: `release.yml` (filename only, including the extension)
   - Environment name: `production` (must match `release.yml`'s `environment:`)
    - Allowed actions: `npm publish`
   npm does not verify this form when you save it; a mismatch only shows up as
   `E404` (`404 Not Found - PUT https://registry.npmjs.org/<name> - Not found`)
   on the next stable release, not `ENEEDAUTH`. The package can already exist;
   npm still answers 404 when this workflow is not a trusted publisher for it.
   Configure both packages **before** the next `Release` run — that job no
   longer carries a token, so a missing publisher is a failed publish, not a
   dry run. A mid-set failure is recoverable: re-dispatch the **same** bump
   (`patch` if that is what failed). Already-published `name@version` pairs
   are skipped so the remaining name, the GitHub Release, and the bump PR can
   finish. Do not dispatch `existing` while git still holds the pre-bump
   version — that republishes the old version, not the one already on the
   scoped name.
3. Keep a **granular access token** for the channels OIDC cannot cover
   (snapshots, nightlies, `npm dist-tag rm`). *Read and write*, **selected
   packages** `cezarion` and `@wjarka/cezarion` only — both names exist, so
   "all packages" / "able to create" is no longer needed. Set an expiry per
   your policy (CI fails loudly with `E401`/`E404`/`EOTP` when it is wrong
   or lapses).
   - **Tick "Bypass two-factor authentication (2FA)"** under the token's
     *Security settings*. A granular token is NOT exempt from 2FA by default —
     the bypass is an explicit opt-in checkbox, and without it an account that
     enforces 2FA on writes makes the registry answer `npm error code EOTP`
     (one-time password required). It aborts *after* uploading the file list,
     so it reads like a mid-publish glitch rather than a credential problem.
     Hit live on #30: a token with read-write on all packages and the bypass
     box left unchecked failed with `EOTP` on `@wjarka/cezarion`. Correct
     scope is not sufficient; this box is the other half.
   - Do **not** answer an `EOTP` by relaxing the account's two-factor mode to
     *authorization only*. That weakens every package the account owns to fix
     one CI job; set the bypass on the token instead, which is scoped to that
     token alone. A classic *Automation* token bypasses 2FA by design and is
     the other valid answer, at the cost of no expiry and account-wide write.
   - Do **not** set Publishing access to *"Require two-factor authentication
     and disallow tokens"*. That is npm's "maximum security" recommendation
     once *every* publish is OIDC; here the token still has to publish
     prereleases and remove dist-tags. Leave it at *"Require two-factor
     authentication or an automation or granular access token"*.
   - npm has no "prerelease-only" token permission. A leaked `NPM_TOKEN` can
     still `npm publish --tag latest`. What the narrowing actually buys: the
     token can no longer create new packages, and only the preview / nightly /
     cleanup jobs receive it. Those jobs never pass `--tag latest`. The
     trusted publisher is the intended `latest` path, not an exclusive one.
4. After rotating the token, for every package: Settings → *Publishing access*
   → **"Require two-factor authentication or an automation or granular access
   token"** (preview CI publishes with the token; humans still need 2FA).

On **GitHub** (this repository):

5. Settings → Secrets and variables → Actions → repository secret **`NPM_TOKEN`**
   with the narrowed token from step 3. Rotate the existing value rather than
   adding a second secret. `release.yml` does not read this secret.
6. Enable **Settings → Actions → General → Workflow permissions → Allow GitHub
   Actions to create and approve pull requests** for version-bump PRs. Organization
   policy may require an administrator to enable it there first. The workflows
   declare their own `permissions:` blocks, so repo-level Actions defaults can
   stay read-only. The `production` environment already gates the Release
   workflow; add reviewers there if a release should require approval.

Nothing is deprecated on the upstream side: this clone publishes under names npm
has never seen, so `@open-mercato/cezar` and `cezar-cli` keep belonging to
upstream and are never written to from here.

## Verifying a preview

- The PR's sticky comment (or the job's step summary for branch pushes) has
  the exact command — e.g. `npx cezarion@0.1.5-pr482.123`.
- `npm view cezarion dist-tags` and `npm view @wjarka/cezarion dist-tags` show
  every active channel on both published names.
- Server flows accept pinned previews too:
  `npx cezarion@<version> server-deploy --platform <id>`
  (see [Remote access](server-install/README.md)).

### Automatic failure reports

Failed Release and Nightly attempts create durable issues with job/step evidence.
See [failure reporting](failure-reporting.md) for matching, permissions, duplicate
handling, missing logs, and how to rerun a failed reporter without retrying a release.
