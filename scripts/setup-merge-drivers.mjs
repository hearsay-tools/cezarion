import { spawnSync } from 'node:child_process'

export const driver = 'node scripts/merge-ratchet-baselines.mjs "%O" "%A" "%B"'

/** Repository-local config is shared by linked worktrees; never overwrite another driver. */
export function setupMergeDriver(cwd = process.cwd()) {
  const key = 'merge.cezar-ratchet.driver'
  const read = spawnSync('git', ['config', '--get-all', key], { cwd, encoding: 'utf8' })
  if (read.error) throw read.error
  if (read.status !== 0 && read.status !== 1) throw new Error(read.stderr.trim())
  if (read.status === 0 && read.stdout.trim() !== driver) throw new Error(`${key} already has a different definition; left unchanged`)
  const write = spawnSync('git', ['config', '--local', key, driver], { cwd, encoding: 'utf8' })
  if (write.error) throw write.error
  if (write.status !== 0) throw new Error(write.stderr.trim())
}

if (import.meta.main) {
  try {
    setupMergeDriver()
    console.log('Installed repository-local cezar-ratchet merge driver')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
