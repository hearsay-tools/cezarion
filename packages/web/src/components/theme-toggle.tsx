import { SunMoonIcon } from '@/components/design-icons'

import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import type { Theme } from '@/lib/theme'

/* A proper icon button (fixes #378 — the legacy text toggle clipped in the sidebar footer).
 * It cycles rather than opening a menu: three states, one target, no popover to hit on mobile.
 * The icon shows the *choice*, not the resolved palette — otherwise `system` would be invisible. */

/** Exported because the ⌘K palette's "Toggle theme" action must cycle exactly like this button —
 *  one order, defined once. */
export const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' }
const LABEL: Record<Theme, string> = { light: 'light', dark: 'dark', system: 'system' }

/** `showLabel`: the expanded project rail (#711) spells the choice out beside the icon,
 *  "Theme · System". The accessible name is the same either way. */
export function ThemeToggle({ className, showLabel = false, labelClassName }: { className?: string; showLabel?: boolean; labelClassName?: string }) {
  const { theme, setTheme } = useTheme()
  const next = NEXT_THEME[theme]
  const Icon = SunMoonIcon

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      data-slot="theme-toggle"
      data-theme-pref={theme}
      title={`Theme: ${LABEL[theme]}`}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}.`}
      onClick={() => setTheme(next)}
    >
      <Icon aria-hidden="true" />
      {showLabel ? <span className={labelClassName}>Theme · {theme.charAt(0).toUpperCase() + theme.slice(1)}</span> : null}
    </Button>
  )
}
