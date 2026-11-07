import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Home } from '../../cezar/src/home/home'
import { HomeStore } from '../../cezar/src/home/store'
import { mergeWriteWorkspaceConfig } from '../../cezar/src/workspace/config'
import { cezarCli, fixtureServeEnv } from './agent-browser'
import { spawnFixtureServer, stopFixtureServer, waitForFixtureServer } from './fixture-server'

export type HomeRecoveryControl =
  | { kind: 'reset-projects' }
  | { kind: 'outside-ui-state' }
  | { kind: 'add-project' }
  | { kind: 'write-ui-state'; value: string }

/** Real CLI and HomeStore share one sandbox. Only the deliberate outside-write case bypasses it. */
export async function createHomeRecoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-home-recovery-e2e-'))
  const env = fixtureServeEnv(root)
  const home = Home.sandbox(env.CEZ_HOME!)
  const store = new HomeStore(home)
  const project = { id: 'recovery-project', root, name: 'Recovery project', source: 'local' as const,
    addedAt: '2026-11-07T00:00:00Z', lastOpenedAt: '2026-11-07T00:00:00Z' }
  Home.seed(home, home.workspaceConfig, { projects: [project] })
  Home.seed(home, home.workspaceUiState, { recoveryFixture: 'original' })
  const server = spawnFixtureServer([cezarCli, 'serve', '--repo', root, '--port', '0', '--no-open'], { env })
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
      } else {
        store.writeJson(home.workspaceUiState, { recoveryFixture: command.value })
      }
    }
    return {
      origin,
      project,
      control,
      readState() {
        return { projects: (JSON.parse(store.read(home.workspaceConfig)) as { projects: Array<{ id: string; root: string }> }).projects,
          uiState: JSON.parse(store.read(home.workspaceUiState)) as { recoveryFixture: string } }
      },
      async reset() {
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
