import { execFileSync } from 'node:child_process';
// The browser harness owns these catalogs; checkout catalogs never seed the server.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_CATALOGS = [
  '.ai/cezar/skills', '.ai/skills', '.agents/skills', '.claude/skills',
  '.codex/skills', '.cursor/skills', '.opencode/skills', '.ai/cezar/workflows',
];
const fixtures = fileURLToPath(new URL('../../packages/web/e2e/fixtures/catalogs/', import.meta.url));

export function replaceProjectCatalogs(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  const tracked = git('ls-files', '-z', '--', ...PROJECT_CATALOGS);
  if (tracked.length) execFileSync('git', ['-C', root, 'update-index', '--skip-worktree', '-z', '--stdin'], { input: tracked });
  const ownerPath = join(root, '.git/cezar-e2e-lane.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  if (!owner.fixedCatalogs) {
    // These are fixture inputs, not project changes. Keep HEAD, log, index blobs and
    // non-catalog source edits intact so git UI specs see the original repository.
    const exclude = join(root, '.git/info/exclude');
    mkdirSync(dirname(exclude), { recursive: true });
    writeFileSync(exclude, `\n${PROJECT_CATALOGS.map(path => `/${path}/`).join('\n')}\n`, { flag: 'a' });
    writeFileSync(ownerPath, JSON.stringify({ ...owner, fixedCatalogs: true }));
  }
  for (const relative of PROJECT_CATALOGS) rmSync(join(root, relative), { recursive: true, force: true });
  for (const [source, relative] of [['skills', '.ai/skills'], ['workflows', '.ai/cezar/workflows']]) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(fixtures, source), target, { recursive: true });
  }
}
