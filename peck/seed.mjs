import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Input is Peck's Given tables as JSON, with normalized table and column names.
const [input, destination] = process.argv.slice(2);
if (!input || !destination) throw new Error('Usage: node peck/seed.mjs <given.json> <empty-run-directory>');
const tables = JSON.parse(readFileSync(input, 'utf8'));
const projects = tables.projects;
const tasks = tables.tasks;
if (!Array.isArray(tables.people) || !Array.isArray(projects) || !Array.isArray(tasks)) {
  throw new Error('Expected people, projects and tasks arrays');
}
for (const row of [...tables.people, ...projects, ...tasks]) {
  if (Object.values(row).some(value => typeof value !== 'string')) throw new Error('Every Given value must be a string');
}
const names = new Set(projects.map(row => row.name));
if (names.size !== projects.length || projects.some(row => !/^[a-z][a-z0-9-]*$/.test(row.name))) {
  throw new Error('Project names must be unique lowercase Git directory names');
}
for (const row of tasks) {
  if (!names.has(row.project) || !row.title || !['done', 'cancelled'].includes(row.status) || !['true', 'false'].includes(row.archived)) {
    throw new Error('Each task needs a title, a known project, a terminal status and a string boolean archived value');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.created_date) || !/^\d{2}:\d{2}$/.test(row.created_time)) {
    throw new Error('Task dates must be YYYY-MM-DD and times HH:MM');
  }
}
const keys = tasks.map(row => `${row.project}\0${row.title}`);
if (new Set(keys).size !== keys.length) throw new Error('Task titles must be unique within each project');

mkdirSync(resolve(destination), { recursive: true });
const root = realpathSync(destination);
if (readdirSync(root).length) throw new Error('Refusing to seed a nonempty run directory; use a fresh directory for each spec');
if (root.includes('/.ai/cezar/worktrees/')) throw new Error('Put the run directory outside task worktrees, for example under /tmp');
for (const dir of ['home', 'tmp', 'projects']) mkdirSync(join(root, dir));
const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: root,
  GIT_AUTHOR_NAME: 'Peck Fixture', GIT_AUTHOR_EMAIL: 'peck@example.invalid',
  GIT_COMMITTER_NAME: 'Peck Fixture', GIT_COMMITTER_EMAIL: 'peck@example.invalid',
};
const registry = [];
for (const project of projects) {
  const repo = join(root, 'projects', project.name);
  mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), `# ${project.name}\n`);
  writeFileSync(join(repo, '.gitignore'), '.ai/\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md', '.gitignore'], ['commit', '-qm', 'Peck fixture']]) {
    execFileSync('git', ['-C', repo, ...args], { env: gitEnv, stdio: 'pipe' });
  }
  const records = tasks.filter(row => row.project === project.name).map(row => {
    const createdAt = new Date(`${row.created_date}T${row.created_time}:00Z`).toISOString();
    const finishedAt = new Date(Date.parse(createdAt) + 60_000).toISOString();
    return {
      id: `peck-${createHash('sha256').update(`${row.project}\0${row.title}`).digest('hex').slice(0, 20)}`,
      title: row.title, task: row.title, workflow: 'quick-task', status: row.status,
      createdAt, finishedAt, tokensUsed: 0, steps: [], archived: row.archived === 'true',
      ...(row.archived === 'true' ? { archivedAt: finishedAt } : {}),
    };
  });
  const dataDir = join(repo, '.ai', 'cezar');
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  writeFileSync(join(dataDir, 'runs.json'), JSON.stringify(records, null, 2) + '\n');
  registry.push({ id: project.name, name: project.name, root: repo, source: 'local', addedAt: '2026-10-01T08:00:00Z', lastOpenedAt: '2026-10-01T08:00:00Z' });
}
writeFileSync(join(root, 'home', 'config.json'), JSON.stringify({ projects: registry }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ runRoot: root, projects: registry.map(({ id, root }) => ({ id, root, page: `/p/${id}` })) }));
