import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The skill's tests run in this checkout and in a copied skill, so they pin Git
// themselves: fixture repositories never read the developer's Git config, and no
// background maintenance deletes objects while a test still uses the repository.
const sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'quality-test-git-'));
const globalConfig = join(sandbox, 'gitconfig');
writeFileSync(globalConfig, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.once('exit', () => rmSync(sandbox, { recursive: true, force: true }));

// The nearest node_modules directory, from the skill upward, that holds a package.
// Dependencies resolve from the skill or an ancestor, as references/tool.md says.
export function nodeModulesWith(name) {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(join(candidate, name, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${name} is not installed in the skill or an ancestor node_modules`);
    dir = parent;
  }
}
