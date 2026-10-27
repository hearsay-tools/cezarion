// Keep test startup sweeps inside directories created by this Vitest worker.
// The production sweep also reaps dead projects from the shared OS temp root.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, resolve } from 'node:path';

const owned = new Map();
const mkdir = fs.mkdirSync;
const readdir = fs.readdirSync;
const isFallback = name => /^cez-agent-[0-9a-f]{12}$/.test(name);

fs.mkdirSync = function (path, options) {
  const name = String(path);
  let existed = true;
  try { fs.lstatSync(name); } catch (error) { if (error.code === 'ENOENT') existed = false; else throw error; }
  const result = mkdir.call(fs, path, options);
  // Recursive mkdir returns undefined when another actor created the entry.
  // Do not claim it based on a stale pre-check.
  const created = typeof options === 'object' && options?.recursive
    ? typeof result === 'string' && resolve(result) === resolve(name)
    : !existed;
  if (created && isFallback(basename(name))) {
    const info = fs.lstatSync(name);
    owned.set(resolve(name), [info.dev, info.ino]);
  }
  return result;
};
fs.readdirSync = function (path, options) {
  const entries = readdir.call(fs, path, options);
  return entries.filter(entry => {
    const name = typeof entry === 'string' ? entry : Buffer.isBuffer(entry) ? entry.toString() : entry.name;
    if (!isFallback(name)) return true;
    const full = resolve(String(path), name), identity = owned.get(full);
    if (!identity) return false;
    try { const info = fs.lstatSync(full); return info.dev === identity[0] && info.ino === identity[1]; }
    catch { return false; }
  });
};
syncBuiltinESMExports();
