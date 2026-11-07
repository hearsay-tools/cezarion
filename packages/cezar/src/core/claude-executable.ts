import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

/** Resolve discovery and execution through the same binary and dry-run precedence. */
export function resolveClaudeExecutable(override?: string): string {
  return override ?? process.env.CEZ_CLAUDE_BIN ??
    (process.env.CEZ_DRY_RUN === '1' ? mockClaudePath() : 'claude');
}

/** Path to the bundled mock (`scripts/mock-claude.mjs`), for CEZ_DRY_RUN=1. */
function mockClaudePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-claude.mjs');
}
