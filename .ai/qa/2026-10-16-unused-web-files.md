# hearsay-tools/cezarion#1141 reproduction

Eligibility checked before assignment on 2026-10-16: OPEN, no assignees, no open PR. The timeline references merged hearsay-tools/cezarion#1143 as the reporting task, not a pending fix.

At base `3040cbf78caf3b61fdd6a2b82bef9cb495a4bdd9`, run from the repository root:

```sh
rg -n 'ghost-code-backdrop|github-nav-contract|ui/(card|scroll-area|separator)' packages/web
node --input-type=module <<'JS'
import { build } from 'esbuild';
const { metafile } = await build({
  entryPoints: ['packages/web/src/main.tsx'], bundle: true, write: false,
  metafile: true, packages: 'external',
  loader: { '.woff2': 'file', '.svg': 'file', '.png': 'file' },
  outdir: '/tmp/cezar-1141-repro', logLevel: 'silent',
});
for (const file of [
  'components/ghost-code-backdrop.tsx', 'lib/github-nav-contract.ts',
  'components/ui/card.tsx', 'components/ui/scroll-area.tsx', 'components/ui/separator.tsx',
]) console.log(file, Object.hasOwn(metafile.inputs, `packages/web/src/${file}`));
JS
```

All five graph checks print `false`. Searches find only the backdrop's own tests and CSS; no importers for the three UI primitives. The issue's claim that the GitHub helper has only its own test as consumer is incomplete: `packages/web/e2e/github-fixture.ts` imports it too. Move that helper unchanged into `e2e/` and update both imports, preserving six unit tests and browser fixture behavior.

Remove the other four modules, the backdrop tests and the backdrop-only stylesheet block. No production behavior changes by construction: no production importer exists, and searches find no other user of the removed selectors or animation names. No new behavior test or viewport/theme assertion is warranted. Loading, empty, error, offline and success states; imagery; motion; touch targets and accessibility are unchanged.
