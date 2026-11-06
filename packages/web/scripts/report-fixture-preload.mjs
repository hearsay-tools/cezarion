/** Fixture-only syscall counters. Both revisions load this before the built service. */
import fs, { realpathSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
export const reportIo = { scans: 0, contentLstat: 0, pageChecks: 0 }
const opendir = fs.promises.opendir, lstat = fs.promises.lstat
fs.promises.opendir = function (path, ...args) {
  let actual = String(path)
  try { actual = realpathSync(path) } catch { /* Count missing artifact directories too. */ }
  if (actual.endsWith('-artifacts')) reportIo.scans++
  return opendir.call(this, path, ...args)
}
fs.promises.lstat = function (path, ...args) {
  if (String(path).endsWith('/content')) {
    reportIo.contentLstat++
    // readEntry uses bigint stats. checkArtifactContentForIndex uses ordinary stats.
    if (!args[0]?.bigint) reportIo.pageChecks++
  }
  return lstat.call(this, path, ...args)
}
syncBuiltinESMExports()
