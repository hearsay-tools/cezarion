// hearsay-tools/cezarion#1295: pi loads a project's .pi/skills and .agents/skills only once the
// user trusts the folder, and an RPC session with no saved decision silently gets neither. Offer
// the same folders through resources_discover for an untrusted folder only: a trusted one already
// loads them under its own settings filters. Extensions, MCP servers and the trust decision itself
// stay untouched.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// pi's CONFIG_DIR_NAME (package.json piConfig.configDir) and getHomeDir(), as of pi 1.0.4.
const CONFIG_DIR_NAME = '.pi';
const homeDir = () => process.env.HOME || homedir();

export default function registerPiProjectSkills(pi) {
  pi.on('resources_discover', (event, ctx) => {
    // A pi without isProjectTrusted has no trust gate, so it already loads the project's skills.
    if (typeof ctx?.isProjectTrusted !== 'function' || ctx.isProjectTrusted()) return;
    const cwd = resolve(event.cwd);
    const userAgentsSkills = resolve(homeDir(), '.agents', 'skills');
    const candidates = [
      join(cwd, CONFIG_DIR_NAME, 'skills'),
      ...ancestorAgentsSkillDirs(cwd).filter((dir) => resolve(dir) !== userAgentsSkills),
    ];
    return { skillPaths: candidates.filter(isDirectory) };
  });
}

// pi's collectAncestorAgentsSkillDirs: cwd up to the first ancestor holding .git (a directory, or
// a linked worktree's file), or the filesystem root when there is none.
function ancestorAgentsSkillDirs(cwd) {
  const gitRoot = findGitRoot(cwd);
  const dirs = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(join(dir, '.agents', 'skills'));
    if (dir === gitRoot || dirname(dir) === dir) return dirs;
  }
}

function findGitRoot(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
