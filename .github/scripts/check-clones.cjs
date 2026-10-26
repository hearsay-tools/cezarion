#!/usr/bin/env node
// Scan Git data with trusted tooling; never load a candidate's config or scripts.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const git = (cwd, args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', ...options });
const eligible = (name) => /^packages\/[^/]+\/src\//.test(name) || name.startsWith('packages/cezar/scripts/');

function check({ repo = process.cwd(), base = 'origin/main', head = 'HEAD' } = {}) {
  const mergeBase = git(repo, ['merge-base', base, head]).trim();
  const headSha = git(repo, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cezar-clones-'));
  try {
    git(scratch, ['init', '--quiet']);
    const objects = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim();
    fs.writeFileSync(path.join(scratch, '.git/objects/info/alternates'), `${objects}\n`);
    git(scratch, ['update-ref', 'refs/heads/baseline', mergeBase]);
    const entries = git(repo, ['ls-tree', '-r', '-z', headSha]).split('\0').filter(Boolean)
      .map((row) => { const tab = row.indexOf('\t'); const meta = row.slice(0, tab); const name = row.slice(tab + 1); return { mode: meta.split(' ')[0], oid: meta.split(' ')[2], name }; })
      .filter(({ mode, name }) => mode.startsWith('100') && eligible(name));
    // One batch avoids a process for each source file. No checkout, symlinks or attributes.
    const blobs = git(repo, ['cat-file', '--batch'], {
      input: entries.map(({ oid }) => oid).join('\n') + '\n', encoding: null, maxBuffer: 128 * 1024 * 1024,
    });
    let offset = 0;
    for (const { name } of entries) {
      const end = blobs.indexOf(10, offset);
      const size = Number(blobs.subarray(offset, end).toString().split(' ')[2]);
      const target = path.join(scratch, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, blobs.subarray(end + 1, end + 1 + size));
      offset = end + size + 2;
    }
    // Explicit config and no gitignore prevent candidate files from weakening the gate.
    const config = path.join(scratch, 'trusted-config.json');
    fs.writeFileSync(config, '{}');
    const result = spawnSync(path.resolve(__dirname, '../../node_modules/.bin/jscpd'), [
      ...Array.from(new Set(entries.map(({ name }) => name.split('/').slice(0, 3).join('/')))), '--config', config, '--no-gitignore', '--absolute', '--no-colors', '--no-tips',
      '--min-tokens', '50', '--min-lines', '5', '--format', 'typescript,tsx,javascript,jsx',
      '--ignore', '**/*.test.*,**/*.testkit.*,**/*.e2e.*,**/__fixtures__/**,**/fixtures/**',
      '--baseline-from-ref', 'baseline', '--fail-on-new-clones', '--reporters', 'console',
    ], { cwd: scratch, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    process.stdout.write((result.stdout || '').replaceAll(scratch + path.sep, ''));
    process.stderr.write(result.stderr || '');
    return result.status ?? 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--base', '--head'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: check-clones.cjs [--base REF] [--head REF]');
    options[args[i].slice(2)] = args[i + 1];
  }
  process.exitCode = check(options);
}
module.exports = { check, eligible };
