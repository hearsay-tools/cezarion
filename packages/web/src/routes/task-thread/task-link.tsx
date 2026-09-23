import { useState, type ComponentPropsWithoutRef } from 'react'
import { LinkSafetyDialog } from './link-safety-dialog'

/** Contextual Markdown still confirms every link that was not resolved to this task. */
export function TaskLink({ href, children, internal, ...props }: ComponentPropsWithoutRef<'a'> & { internal: boolean }) {
  const [open, setOpen] = useState(false)
  if (!href) return <span>{children}</span>
  if (internal) return <a {...props} href={href} data-streamdown="link" className="text-accent-text underline underline-offset-2">{children}</a>
  return <>
    <a {...props} href={href} data-streamdown="link" className="cursor-pointer text-accent-text underline underline-offset-2" onClick={event => { event.preventDefault(); setOpen(true) }}>{children}</a>
    <LinkSafetyDialog isOpen={open} url={href} onClose={() => setOpen(false)} onConfirm={() => { window.open(href, '_blank', 'noreferrer'); setOpen(false) }} />
  </>
}
