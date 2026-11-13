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
  it.each([
    ['New project…', 'New project'],
    ['Open local folder…', 'Choose local folder'],
    ['Clone from GitHub…', 'Clone repository'],
  ])('opens its own dialog from %s', (item, dialog) => {
    render(<AddProjectMenu />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: item }))
    expect(screen.getByRole('dialog', { name: dialog })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('mounts the New project dialog only once it is chosen', () => {
    render(<AddProjectMenu />)
    expect(screen.queryByRole('dialog', { name: 'New project' })).toBeNull()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New project…' }))
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy()
  })
})
