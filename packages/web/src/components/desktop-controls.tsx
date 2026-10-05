import { useState } from 'react'
import { SelfUpdateDialog } from './self-update-dialog'
/** Only the local desktop window injects this marker. Remote windows receive no native bridge. */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__CEZ_DESKTOP__' in window
}
export function DesktopControls() {
  const [open, setOpen] = useState(false)
  return <>
    <div data-slot="desktop-titlebar" data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 flex h-7 items-center gap-4 border-b border-border bg-background pl-20 text-[11px]">
      <span data-tauri-drag-region>Cezarion · Local</span>
      <button type="button" className="rounded px-2 hover:bg-muted" onClick={() => setOpen(true)}>Versions &amp; updates</button>
    </div>
    {open ? <SelfUpdateDialog open={open} onOpenChange={setOpen} /> : null}
  </>
}
