// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ rebrand: false, displayName: '' }))
vi.mock('./product-name', async importOriginal => {
  const actual = await importOriginal<typeof import('./product-name')>()
  return { productName: (legacy: 'cezar' | 'Cezar' | 'Cezarion') => actual.productName(legacy, state) }
})

import { readProductIdentity } from '../../product-identity'
import { DesktopControls } from '@/components/desktop-controls'
import { documentTitleOf } from './use-document-title'

afterEach(() => { vi.resetModules() })

describe.each([false, true])('cockpit product display (switch %s)', rebrand => {
  it('renders the desktop label and task controls from the same identity', async () => {
    Object.assign(state, readProductIdentity(rebrand))
    // Task row labels are built at module load, as they are in the shipped bundle.
    const { TaskAccessControls } = await import('@/components/task-access-controls')
    const desktop = renderToStaticMarkup(<DesktopControls />)
    const access = renderToStaticMarkup(<TaskAccessControls allowWorkers allowMessaging onChange={() => {}} />)
    expect(desktop).toContain(`${rebrand ? state.displayName : 'Cezarion'} · Local`)
    expect(access).toContain(`Allow ${rebrand ? state.displayName : 'cezar'} workers`)
    expect(access).toContain(`start ${rebrand ? state.displayName : 'Cezar'} workers`)
  })

  it('changes only the product suffix in document titles', () => {
    Object.assign(state, readProductIdentity(rebrand))
    const name = rebrand ? state.displayName : 'cezar'
    expect(documentTitleOf({ projectName: null, pageLabel: null })).toBe(name)
    expect(documentTitleOf({ projectName: 'cezar', pageLabel: 'Cezarion' })).toBe(`cezar — Cezarion · ${name}`)
    expect(documentTitleOf({ projectName: 'Shop', pageLabel: null })).toBe(`Shop · ${name}`)
    expect(documentTitleOf({ projectName: null, pageLabel: 'Tasks' })).toBe(`Tasks · ${name}`)
  })
})
