import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'
import { Switch } from './switch'

// docs/areas/web-ui.md § Accessibility rules: under prefers-reduced-motion nothing moves.
// Tailwind compiles `motion-safe:` into that media query, so the class on the shared
// primitive is the whole proof; a browser spec would only re-test Tailwind.
const ungated = (className: string, utility: string) =>
  className.split(/\s+/).filter((token) => token.split(':').at(-1) === utility && !token.includes('motion-safe:'))

describe('shared primitives move only when motion is allowed', () => {
  it('slides the switch thumb only under motion-safe', () => {
    render(<Switch aria-label="Toggle" />)
    const thumb = document.querySelector('[data-slot="switch-thumb"]')!.className
    expect(thumb).toContain('motion-safe:transition-transform')
    expect(ungated(thumb, 'transition-transform')).toEqual([])
  })

  it('zooms the dialog in and out only under motion-safe', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    for (const slot of ['dialog-overlay', 'dialog-content']) {
      const className = document.querySelector(`[data-slot="${slot}"]`)!.className
      expect(className, slot).toContain('motion-safe:data-[state=open]:animate-in')
      for (const utility of ['animate-in', 'animate-out', 'zoom-in-95', 'zoom-out-95']) {
        expect(ungated(className, utility), `${slot} ${utility}`).toEqual([])
      }
    }
  })
})
