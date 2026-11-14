import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Home } from '../../cezar/src/home/home'
import { HomeStore } from '../../cezar/src/home/store'
import { migrateLegacyHome } from '../../cezar/src/home/migrate'
import { acceptHomeRecovery, getHomeRecovery } from '../../cezar/src/home/recovery'
import { readMigrationRecord } from '../../cezar/src/home/migration-record'
import { mergeWriteWorkspaceConfig } from '../../cezar/src/workspace/config'
import { squawkCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'

export type HomeRecoveryControl =
  | { kind: 'reset-projects' }
  | { kind: 'outside-ui-state' }
  | { kind: 'add-project' }
  | { kind: 'write-ui-state'; value: string }
  | { kind: 'legacy-ui-state'; value: string }

/**
 * Real CLI and HomeStore share one sandbox. Only the deliberate outside-write case bypasses it.
 * The server's CEZ_HOME names the legacy home this fixture migrated, as an operator's does, so a
 * boot with the release switch on finds that migration done.
 */
export async function createHomeRecoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-home-recovery-e2e-'))
  const env = fixtureServeEnv(root)
  const legacy = Home.sandbox(join(root, 'legacy'), { layout: 'legacy' })
  const home = Home.sandbox(env.CEZ_HOME!, { layout: 'split' })
  const store = new HomeStore(home)
  const project = { id: 'recovery-project', root, name: 'Recovery project', source: 'local' as const,
    addedAt: '2026-11-07T00:00:00Z', lastOpenedAt: '2026-11-07T00:00:00Z' }
  Home.seed(legacy, legacy.workspaceConfig, { projects: [project] })
  Home.seed(legacy, legacy.workspaceUiState, { recoveryFixture: 'original' })
  migrateLegacyHome(legacy, home)
  const server = spawnFixtureServer([join(import.meta.dirname, 'home-recovery-server.mjs'),
    dirname(squawkCli), root, env.CEZ_HOME!], { env: { ...env, CEZ_HOME: legacy.root } })
  try {
    const origin = await waitForFixtureServer(server)
    const control = async (command: HomeRecoveryControl): Promise<void> => {
      if (command.kind === 'reset-projects') {
        await mergeWriteWorkspaceConfig(config => { config.projects = [] }, home)
      } else if (command.kind === 'add-project') {
        await mergeWriteWorkspaceConfig(config => { config.projects = [project] }, home)
      } else if (command.kind === 'outside-ui-state') {
        // Deliberate bypass: this case proves the server discovers a foreign process's write.
        writeFileSync(home.workspaceUiState, JSON.stringify({ recoveryFixture: 'outside' }))
      } else if (command.kind === 'legacy-ui-state') {
        // Deliberate older-binary write to the migrated home, never the user's home.
        writeFileSync(legacy.workspaceUiState, JSON.stringify({ recoveryFixture: command.value }))
      } else {
        store.writeJson(home.workspaceUiState, { recoveryFixture: command.value })
      }
    }
    return {
      origin,
      project,
      control,
      legacyHash() {
        return readMigrationRecord(home)?.files.find(file => file.path === 'ui-state.json')?.hash
      },
      readState() {
        return { projects: (JSON.parse(store.read(home.workspaceConfig)) as { projects: Array<{ id: string; root: string }> }).projects,
          uiState: JSON.parse(store.read(home.workspaceUiState)) as { recoveryFixture: string } }
      },
      async reset() {
        for (const incident of getHomeRecovery(home).files) {
          if (incident.reason === 'legacy-change') acceptHomeRecovery(home, incident.file, incident.detectedAt)
        }
        // Each case starts from an explicitly accepted, then reseeded private home.
        for (const path of [home.workspaceConfig, `${home.workspaceConfig}.bak`, home.workspaceUiState]) store.acceptOutsideWrite(path)
        await mergeWriteWorkspaceConfig(config => { config.projects = [project] }, home)
        store.writeJson(home.workspaceUiState, { recoveryFixture: 'original' })
      },
      async stop() {
        await stopFixtureServer(server)
        rmSync(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await stopFixtureServer(server)
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
