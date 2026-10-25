// The two demo repositories the README screenshots show (hearsay-tools/cezarion#1456). The
// cockpit header shows a project's path, so both live under `<root>/code/`. `cezarion` holds
// this checkout's files, so every path a scripted turn reads or edits is real; `storefront` is
// a small second project, so the rail shows two.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GITHUB_REPO } from './scenarios.mjs';

/**
 * Paths left out of the `cezarion` copy. Each task gets its own worktree of it, and these are
 * 39 MB of benchmark archives, images and agent records that no scripted turn reads.
 */
export const EXCLUDED_PATHS = Object.freeze(['docs', '.ai']);

export const STOREFRONT_FILES = Object.freeze({
  'package.json': `${JSON.stringify({ name: 'storefront', private: true, type: 'module', scripts: { dev: 'vite', test: 'vitest run' } }, null, 2)}\n`,
  'README.md': '# Storefront\n\nThe shop front end: catalog, cart and checkout.\n',
  'src/cart/store.ts': "export interface CartLine { sku: string; quantity: number }\n\nexport function addLine(lines: CartLine[], sku: string): CartLine[] {\n  const line = lines.find((entry) => entry.sku === sku);\n  if (!line) return [...lines, { sku, quantity: 1 }];\n  return lines.map((entry) => (entry === line ? { ...entry, quantity: entry.quantity + 1 } : entry));\n}\n",
  'src/components/header.tsx': "export function Header({ title }: { title: string }) {\n  return <header className=\"site-header\"><h1>{title}</h1></header>;\n}\n",
});

/** Workflows the seeded tasks and the workflow-builder cell use. None of them has a skill step
 *  the tasks run: under dry run no namer runs, and a skill step would title a task `/<skill>`. */
export const DEMO_WORKFLOWS = Object.freeze({
  'fix-and-verify.yaml': `name: fix-and-verify
description: Implement the task, then run the checks; on failure the agent retries with the failing output.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
  - id: verify
    name: Verify
    command: "git diff --check"
    onFail:
      retry: implement
      max: 2
`,
  'implement-and-review.yaml': `name: implement-and-review
description: Implement the task, run a security review of the diff, then write the changelog entry.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
  - id: security-review
    name: Security review
    skill: security-review
    prompt: "Review the diff for: {{task}}"
  - id: changelog
    name: Changelog
    skill: changelog
    prompt: "Write the changelog entry for: {{task}}"
`,
});

/** Skills for the workflow builder's list and the workflow above. */
export const DEMO_SKILLS = Object.freeze({
  'changelog': 'Write a changelog entry for the change on this branch.',
  'dependency-upgrade': 'Upgrade a dependency, read its release notes and fix what breaks.',
  'fix-flaky-test': 'Reproduce a flaky test under load, find the race and fix it.',
  'security-review': 'Review the diff for injection, secrets and unsafe defaults.',
});

function git(cwd, env, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Write `files` (relative path → text) under `root`. */
export function writeTree(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** The cezar workflows and skills both demo repositories carry. */
export function cezarFiles() {
  const files = {};
  for (const [name, text] of Object.entries(DEMO_WORKFLOWS)) files[`.ai/cezar/workflows/${name}`] = text;
  for (const [name, description] of Object.entries(DEMO_SKILLS)) {
    files[`.ai/cezar/skills/${name}.md`] = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`;
  }
  return files;
}

/** `source`'s committed files at HEAD, without EXCLUDED_PATHS, extracted into `dest`. */
function copyCheckout(source, dest, env) {
  mkdirSync(dest, { recursive: true });
  const tar = `${dest}.tar`;
  const excludes = EXCLUDED_PATHS.map((path) => `:(exclude)${path}`);
  git(source, env, 'archive', '--format=tar', '-o', tar, 'HEAD', '--', '.', ...excludes);
  try {
    execFileSync('tar', ['-xf', tar, '-C', dest]);
  } finally {
    rmSync(tar, { force: true });
  }
}

/** A new repository on `main` whose one commit holds everything under `root`. */
function commitAll(root, env) {
  git(root, env, 'init', '-q', '-b', 'main');
  git(root, env, 'add', '-A');
  git(root, env, 'commit', '-q', '-m', 'Initial commit');
}

/**
 * Create both demo repositories under `<root>/code/`. `env` must carry a Git identity: the
 * caller's own Git config is not read. The `cezarion` copy's `origin` names GITHUB_REPO, which
 * the GitHub cell reads; nothing pushes to it.
 */
export function createDemoRepos({ source, root, env }) {
  const cezarion = join(root, 'code', 'cezarion');
  const storefront = join(root, 'code', 'storefront');
  copyCheckout(source, cezarion, env);
  writeTree(storefront, STOREFRONT_FILES);
  for (const repo of [cezarion, storefront]) {
    writeTree(repo, cezarFiles());
    commitAll(repo, env);
  }
  git(cezarion, env, 'remote', 'add', 'origin', `https://github.com/${GITHUB_REPO}.git`);
  return { cezarion, storefront };
}
