import type { ReactNode } from 'react'

import { chipClass } from '@/components/picker-pill'
import { cn } from '@/lib/utils'

/** A toggle chip at form size: the composer's pill grammar on a 44 px target. `aria-pressed`
 *  carries the state for assistive tech; the fill carries it for everyone else. */
export function ChipButton({ pressed, onClick, disabled, children }: { pressed: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        chipClass,
        'h-11 px-4 text-[13px]',
        pressed && 'border-transparent bg-accent-strong text-accent-strong-foreground hover:bg-accent-strong hover:text-accent-strong-foreground',
      )}
    >
      {children}
    </button>
  )
}
