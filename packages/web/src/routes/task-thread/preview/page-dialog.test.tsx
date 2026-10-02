import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PageDialog } from './page-dialog'

afterEach(() => cleanup())

describe('PageDialog (5.13)', () => {
  it('labels the dialog with the page origin and maps Esc to Cancel', () => {
    const onResult = vi.fn()
    render(<PageDialog dialog={{ t: 'dialog', type: 'confirm', message: 'Suspend Mara Okafor?', origin: 'localhost:5173' }} onResult={onResult} />)
    expect(screen.getByText('localhost:5173 says')).toBeTruthy()
    expect(screen.getByText('Suspend Mara Okafor?')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onResult).toHaveBeenCalledWith({ accept: false })
  })

  it('maps Esc to Cancel when focus sits outside the dialog', () => {
    const onResult = vi.fn()
    render(<PageDialog dialog={{ t: 'dialog', type: 'confirm', message: 'Sure?', origin: 'localhost:5173' }} onResult={onResult} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({ accept: false })
  })

  it('sends the typed answer of a prompt on OK', () => {
    const onResult = vi.fn()
    render(<PageDialog dialog={{ t: 'dialog', type: 'prompt', message: 'Name?', defaultPrompt: 'Ada', origin: 'localhost:5173' }} onResult={onResult} />)
    const field = screen.getByRole('textbox') as HTMLInputElement
    expect(field.value).toBe('Ada')
    fireEvent.change(field, { target: { value: 'Mara' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onResult).toHaveBeenCalledWith({ accept: true, text: 'Mara' })
  })

  it('an alert has only OK, and beforeunload asks Stay or Leave', () => {
    const onResult = vi.fn()
    const { rerender } = render(<PageDialog dialog={{ t: 'dialog', type: 'alert', message: 'Saved', origin: 'localhost:5173' }} onResult={onResult} />)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    rerender(<PageDialog dialog={{ t: 'dialog', type: 'beforeunload', message: '', origin: 'localhost:5173' }} onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    expect(onResult).toHaveBeenCalledWith({ accept: false })
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(onResult).toHaveBeenCalledWith({ accept: true })
  })
})
