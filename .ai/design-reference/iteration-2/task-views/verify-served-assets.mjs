import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Adapted from parent fixture d94958cc's verify-proof.mjs. Use this worker's
// existing isolated server; verify all font formats, including IBM Plex TTF.
const evidence = resolve('.ai/design-reference/iteration-2/task-views');
const runtime = JSON.parse(readFileSync(`${evidence}/runtime-proof.json`, 'utf8'));
const source = JSON.parse(readFileSync(`${evidence}/source-proof.json`, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = new URL(runtime.baseUrl);
if (base.hostname !== '127.0.0.1') throw new Error('Expected isolated loopback fixture');
process.kill(runtime.pid, 0);
const command = readFileSync(`/proc/${runtime.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
if (!command.includes(runtime.entry) || !command.includes(runtime.repo)) throw new Error('Process provenance mismatch');
async function fetchBytes(path) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return Buffer.from(await response.arrayBuffer());
}
const indexSha256 = hash(readFileSync(`${runtime.webRoot}/index.html`));
if (hash(await fetchBytes('/')) !== indexSha256) throw new Error('Served index differs from disk');
const assets = [];
for (const file of readdirSync(`${runtime.webRoot}/assets`).filter(name => /\.(js|css|woff2?|ttf|otf)$/.test(name))) {
  const local = hash(readFileSync(`${runtime.webRoot}/assets/${file}`));
  const served = hash(await fetchBytes(`/assets/${file}`));
  if (local !== served) throw new Error(`Served asset differs: ${file}`);
  assets.push({ file, sha256: local, servedSha256: served });
}
const health = JSON.parse((await fetchBytes('/api/v1/health')).toString());
if (health.repoRoot !== runtime.repo) throw new Error('Health repo differs from fixture');
writeFileSync(`${evidence}/served-asset-proof.json`, JSON.stringify({
  checkedAt: new Date().toISOString(), verifierOrigin: 'parent d94958cc',
  sourceCommit: source.sourceCommit, designSha256: source.sourceDesignSha256,
  baseUrl: runtime.baseUrl, pid: runtime.pid, entry: runtime.entry, repo: runtime.repo,
  indexSha256, assets, verified: true,
}, null, 2) + '\n');
console.log(`PASS: process, repo, index and ${assets.length} served JS/CSS/font assets match disk.`);
