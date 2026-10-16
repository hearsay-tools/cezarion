import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AddProjectMenu } from '@/components/add-project-menu'

vi.mock('@/components/add-project-dialog', () => ({ AddProjectDialog: () => <div role="dialog" aria-label="Choose local folder" /> }))
vi.mock('@/components/clone-project-dialog', () => ({ CloneProjectDialog: () => <div role="dialog" aria-label="Clone repository" /> }))
vi.mock('@/components/create-project-dialog', () => ({ CreateProjectDialog: () => <div role="dialog" aria-label="New project" /> }))

afterEach(cleanup)

/** Radix opens a dropdown on pointerdown (mouse, primary button), not on click. */
function openMenu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Add project' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

describe('AddProjectMenu', () => {
  it('lists New project first, then the two existing flows', () => {
    render(<AddProjectMenu />)
    openMenu()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'New project…',
      'Open local folder…',
      'Clone from GitHub…',
    ])
  })

  it('mounts the New project dialog only once it is chosen', () => {
    render(<AddProjectMenu />)
    expect(screen.queryByRole('dialog', { name: 'New project' })).toBeNull()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New project…' }))
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy()
  })
})
