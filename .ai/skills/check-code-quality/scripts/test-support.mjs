import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The skill's tests run in this checkout and in a copied skill, so they pin Git
// themselves: fixture repositories never read the developer's Git config, and no
// background maintenance deletes objects while a test still uses the repository.
const sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'quality-test-git-'));
const globalConfig = join(sandbox, 'gitconfig');
writeFileSync(globalConfig, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.once('exit', () => rmSync(sandbox, { recursive: true, force: true }));
