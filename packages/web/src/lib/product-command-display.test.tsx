import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readProductIdentity, type DisplayIdentity } from '../../product-identity'
import type { SelfUpdateStatus } from '@open-mercato/cezar-api-client'
import { SelfUpdateDialog } from '@/components/self-update-dialog'
import { selfUpdateQueryKeys } from '@/api/self-update-queries'
import { conversationDeliveryExplanation } from '@/routes/task-thread/conversation-presentation'
import { createQueryClient } from '@/api/query-client'
import { skillSourcesKey } from '@/api/skill-sources-client'
import { TeamSourcesPanel } from '@/components/team-sources-panel'
import { CopyAsCliCard } from '@/routes/automations/copy-as-cli-card'
import { fromDefinition } from '@/routes/automations/editor-draft'
import { BookmarkletPanel } from '@/routes/settings/bookmarklets-section'
import { cliOf } from './automation-cli'

const state = vi.hoisted(() => ({ identity: undefined as DisplayIdentity | undefined }))
vi.mock('./product-name', async importOriginal => {
  const actual = await importOriginal<typeof import('./product-name')>()
  return {
    ...actual,
    productCommand: () => actual.productCommand(state.identity),
    productNpx: () => actual.productNpx(state.identity),
    productPackageNpx: () => actual.productPackageNpx(state.identity),
    productName: (legacy: 'cezar' | 'Cezar' | 'Cezarion') => actual.productName(legacy, state.identity),
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const draft = fromDefinition({
  name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 },
  task: { prompt: 'Check', worktree: true },
})

describe.each([false, true])('browser command hints (switch %s)', rebrand => {
  it('uses the shared command for both generated automation forms', () => {
    state.identity = readProductIdentity(rebrand)
    expect(cliOf(draft)).toBe(`${state.identity.command} automation add --name 'Nightly' --cron '0 4 * * *' --prompt 'Check'`)
    const json = cliOf({ ...draft, description: 'Details' })
    expect(json.startsWith(`${state.identity.command} automation create --json '`)).toBe(true)
    expect(json).toContain('"description":"Details"')
  })

  it('names the command that resumes an owned worker', () => {
    state.identity = readProductIdentity(rebrand)
    expect(conversationDeliveryExplanation({ delivery: 'not-delivered', state: 'continuation-required' }, undefined))
      .toContain(`with ${state.identity.command} worker resume`)
  })

  it.each(['global-npm', 'npx', 'checkout'] as const)('renders the install hint for %s', installKind => {
    state.identity = readProductIdentity(rebrand)
    const status: SelfUpdateStatus = {
      version: '1.2.3', installKind, entry: '/fixture/index.js', canSelfUpdate: false,
      channel: 'stable', restartMode: 'reexec', latest: { stable: null, nightly: null },
      updateAvailable: null, checkedAt: null, installed: [], available: [], job: null, activeRuns: 0,
    }
    const client = createQueryClient()
    client.setQueryData(selfUpdateQueryKeys.status, status)
    render(<QueryClientProvider client={client}><SelfUpdateDialog open onOpenChange={() => {}} /></QueryClientProvider>)
    const command = installKind === 'checkout' ? 'node packages/cezar/dist/index.js install'
      : installKind === 'global-npm' ? `${state.identity.command} install` : `${rebrand ? 'npx -p @hearsay-tools/squawk hsq' : 'npx @wjarka/cezarion'} install`
    expect(screen.getByText(command)).toBeTruthy()
  })

  it('renders the automation, remote settings and npm hints from the shared identity', () => {
    state.identity = readProductIdentity(rebrand)
    // Queries stay pending; seeded sources expose the remote hint without a network dependency.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const client = createQueryClient()
    client.setQueryData(skillSourcesKey(), { sources: [], editable: false, configIssue: null })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/p/sample/settings']}>
          <CopyAsCliCard draft={draft} />
          <TeamSourcesPanel />
          <BookmarkletPanel skills={[]} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByText(`${state.identity.command} automation schema`)).toBeTruthy()
    expect(screen.getByText(`${state.identity.command} remote-settings enable`)).toBeTruthy()
    expect(screen.getByText(state.identity.npx)).toBeTruthy()
    expect(state.identity.npx).toBe(rebrand ? 'npx -p @hearsay-tools/squawk hsq' : 'npx cezarion')
    expect(screen.getByText((text, element) => element?.tagName === 'PRE' && text.includes(`${state.identity!.command} automation add`))).toBeTruthy()
  })
})
