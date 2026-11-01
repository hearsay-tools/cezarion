import { useState, type ComponentPropsWithoutRef, type MouseEvent } from 'react'
import { useInRouterContext, useLocation, useNavigate, type Location, type NavigateFunction } from 'react-router'
import { LinkSafetyDialog } from './link-safety-dialog'

type Props = ComponentPropsWithoutRef<'a'> & { internal: boolean }
const LINK = 'text-accent-text underline underline-offset-2'

/** Contextual Markdown still confirms every link that was not resolved to this task. */
export function TaskLink({ href, children, internal, ...props }: Props) {
  const [open, setOpen] = useState(false)
  const routed = useInRouterContext()
  if (!href) return <span>{children}</span>
  if (internal) return routed ? <RoutedLink {...props} href={href}>{children}</RoutedLink> : <a {...props} href={href} data-streamdown="link" className={LINK}>{children}</a>
  return <>
    <a {...props} href={href} data-streamdown="link" className={`cursor-pointer ${LINK}`} onClick={event => { event.preventDefault(); setOpen(true) }}>{children}</a>
    <LinkSafetyDialog isOpen={open} url={href} onClose={() => setOpen(false)} onConfirm={() => { window.open(href, '_blank', 'noreferrer'); setOpen(false) }} />
  </>
}

/** A resolved link navigates inside the app: no reload, so Back returns to the mounted source
 *  view with its restored scroll (hearsay-tools/cezarion#2400). Modified clicks stay native. */
function RoutedLink({ href, children, ...props }: ComponentPropsWithoutRef<'a'> & { href: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  return <a {...props} href={href} data-streamdown="link" className={LINK} onClick={event => followInApp(event, navigate, href, location)}>{children}</a>
}

/** A plain primary click navigates in the app; modified clicks (new tab, new window) stay native.
 *  The source view travels in the entry's state, so the reader's Back can return to it. */
export function followInApp(event: MouseEvent<HTMLAnchorElement>, navigate: NavigateFunction, href: string, from: Location): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  void navigate(href, { state: { readerFrom: from.pathname + from.search } })
}
