import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CircleStopIcon,
  EllipsisIcon,
  GlobeIcon,
  Link2Icon,
  LinkIcon,
  LockIcon,
  MaximizeIcon,
  MonitorIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ServerIcon,
  SmartphoneIcon,
  TabletIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'

import type { PreviewServer } from '@open-mercato/cezar-api-client'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import { ExperimentalBadge } from './experimental-badge'
import { entryFor, serverStatus } from './preview-state'
import { displayUrl } from './preview-url'
import type { ThreadPreviewServer } from '../thread-state'

/**
 * The pane's toolbar (design 04, 4.1 to 4.3 and the mobile frame). Order: Session (only where the
 * pane replaces the transcript), back, forward, reload, server switcher (two or more servers),
 * address, viewport, stats, Experimental badge, More, close.
 *
 * Room rule: the switcher or the adopted label take space from the address, so the stats shrink
 * to their dot (the numbers move into More) and the badge to its icon.
 */

export type PreviewViewport = 'fit' | { w: number; h: number }

export const VIEWPORT_PRESETS = [
  { w: 390, h: 844, icon: SmartphoneIcon },
  { w: 820, h: 1180, icon: TabletIcon },
  { w: 1440, h: 900, icon: MonitorIcon },
] as const

/** Without a frame for this long the stats read `idle`: the page is simply not changing. */
export const PREVIEW_IDLE_MS = 1000

export interface PreviewStatsValue {
  fps: number
  kbps: number
  rttMs?: number
  /** Wall clock of the newest frame; the toolbar compares it to its own clock. */
  lastFrameAt?: number
}

export interface PreviewToolbarProps {
  /** The page's full URL; empty before anything is open. */
  url: string
  servers: readonly PreviewServer[]
  /** The registered server being shown. Absent for a typed URL. */
  current?: PreviewServer
  /** The page comes from a server cezar did not start (5.18). */
  adopted: boolean
  viewport: PreviewViewport
  /** A phone: two rows, no viewport menu, no stats, close inside More. */
  compact?: boolean
  /** A page is streaming, so back, forward and reload mean something. */
  navEnabled: boolean
  /** First open in progress (5.10): the thin bar under the toolbar. */
  loading?: boolean
  /** Where each registered server stands now; a server missing here reads as just registered. */
  serverStates?: ReadonlyMap<number, ThreadPreviewServer>
  /** The Experimental badge. False where the stage carries it instead (5.14). */
  badge?: boolean
  /** Present while frames flow. */
  stats?: PreviewStatsValue
  /** Shown in the stats' place when nothing streams: `server exited`, `offline`, `not started`. */
  status?: { tone: StatusDotTone; label: string }
  urlInputRef?: RefObject<HTMLInputElement | null>
  /** Set where the pane replaces the transcript; the control returns to it. */
  onSession?: () => void
  onNavigate: (input: string) => void
  onBack: () => void
  onForward: () => void
  onReload: (ignoreCache: boolean) => void
  onPickServer: (port: number) => void
  onViewport: (viewport: PreviewViewport) => void
  onCopyUrl: () => void
  onStop: (port: number) => void
  onClose: () => void
}

const iconButton = 'size-8 shrink-0 max-md:size-11'

export const viewportLabel = (viewport: PreviewViewport): string => (viewport === 'fit' ? 'Fit' : `${viewport.w} × ${viewport.h}`)

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

const statsText = (stats: PreviewStatsValue): string =>
  `${stats.fps} fps · ${stats.kbps} KB/s${stats.rttMs === undefined ? '' : ` · ${stats.rttMs} ms`}`

function Stats({ stats, shrunk }: { stats: PreviewStatsValue; shrunk: boolean }) {
  const now = useNow(250)
  const idle = stats.lastFrameAt === undefined || now - stats.lastFrameAt >= PREVIEW_IDLE_MS
  if (shrunk) {
    return <StatusDot data-slot="preview-stats" tone={idle ? 'neutral' : 'success'} aria-label="Preview is live" role="img" />
  }
  return (
    <span data-slot="preview-stats" className="flex shrink-0 items-center gap-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground">
      <StatusDot tone={idle ? 'neutral' : 'success'} aria-hidden="true" />
      {idle ? 'idle' : statsText(stats)}
    </span>
  )
}

export function PreviewToolbar(props: PreviewToolbarProps) {
  const { url, servers, current, adopted, viewport, compact = false, navEnabled, loading = false, stats, status, badge = true } = props
  const switcher = servers.length >= 2
  const crowded = switcher || adopted
  const ownInput = useRef<HTMLInputElement | null>(null)
  const input = props.urlInputRef ?? ownInput
  const focusUrlAfterMenu = useRef(false)
  // `draft` is only what the owner typed. Focus alone shows the full URL, so a URL that arrives
  // while the field is focused still shows.
  const [draft, setDraft] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)

  const back = (
    <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="Back" disabled={!navEnabled} onClick={props.onBack}>
      <ArrowLeftIcon aria-hidden="true" />
    </Button>
  )
  const forward = (
    <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="Forward" disabled={!navEnabled} onClick={props.onForward}>
      <ArrowRightIcon aria-hidden="true" />
    </Button>
  )
  const reload = (
    <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="Reload" aria-busy={loading || undefined} disabled={!navEnabled || loading} onClick={() => props.onReload(false)}>
      <RotateCwIcon aria-hidden="true" />
    </Button>
  )

  const switcherMenu = switcher ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-[11rem] min-w-0 gap-1.5 max-md:h-11"
          aria-label={current ? `Server: ${current.label} :${current.port}` : 'Server'}
        >
          {current ? <StatusDot tone="neutral" shape="ring" aria-hidden="true" /> : <ServerIcon aria-hidden="true" />}
          <span className="truncate">{current ? current.label : 'Server'}</span>
          {current ? <span className="font-mono font-normal text-muted-foreground">:{current.port}</span> : null}
          <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-64"
        onCloseAutoFocus={event => {
          if (!focusUrlAfterMenu.current) return
          focusUrlAfterMenu.current = false
          event.preventDefault()
          input.current?.focus()
        }}
      >
        {servers.map(server => {
          const look = serverStatus(entryFor(server, props.serverStates))
          return (
            <DropdownMenuItem key={server.port} className="min-h-11 gap-2.5 md:min-h-0" onSelect={() => props.onPickServer(server.port)}>
              <StatusDot tone={look.tone} shape={look.ring ? 'ring' : 'filled'} pulse={look.pulse} aria-hidden="true" />
              <span className="font-semibold">{server.label}</span>
              <span className="font-mono text-muted-foreground">:{server.port}</span>
              <span className="ml-auto text-xs text-muted-foreground">{look.text}</span>
              {current?.port === server.port ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-11 gap-2.5 md:min-h-0"
          onSelect={() => {
            focusUrlAfterMenu.current = true
          }}
        >
          <GlobeIcon aria-hidden="true" />
          Type a URL instead
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  const address = (
    <div className="relative flex min-w-0 flex-1 items-center">
      <GlobeIcon className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <input
        ref={input}
        type="text"
        aria-label="Page address"
        placeholder="Type a URL or a port"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={draft ?? (focused ? url : displayUrl(url))}
        title={url || undefined}
        className={cn(
          'h-8 w-full min-w-0 truncate rounded-md border border-transparent bg-muted pl-8 font-mono text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/30 max-md:h-11',
          adopted ? 'pr-40' : 'pr-2.5',
        )}
        onFocus={event => {
          const field = event.currentTarget
          setFocused(true)
          // After the full URL replaces the short one, so the whole address is selected.
          requestAnimationFrame(() => {
            if (document.activeElement === field) field.select()
          })
        }}
        onBlur={() => {
          setFocused(false)
          setDraft(null)
        }}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            props.onNavigate(draft ?? url)
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            event.currentTarget.blur()
          }
        }}
      />
      {adopted && !focused ? (
        <span className="pointer-events-none absolute right-2 inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2 text-xs font-semibold text-muted-foreground">
          <Link2Icon className="size-3" aria-hidden="true" />
          Not started by cezar
        </span>
      ) : null}
    </div>
  )

  const viewportMenu = compact ? null : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" aria-label={`Viewport size: ${viewportLabel(viewport)}`}>
          {viewport === 'fit' ? <MaximizeIcon aria-hidden="true" /> : <MonitorIcon aria-hidden="true" />}
          <span className={viewport === 'fit' ? undefined : 'font-mono font-normal'}>{viewportLabel(viewport)}</span>
          <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuItem className="gap-2.5" onSelect={() => props.onViewport('fit')}>
          <MaximizeIcon aria-hidden="true" />
          Fit
          <span className="ml-auto text-xs text-muted-foreground">pane size</span>
          {viewport === 'fit' ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
        </DropdownMenuItem>
        {VIEWPORT_PRESETS.map(({ w, h, icon: Icon }) => (
          <DropdownMenuItem key={`${w}x${h}`} className="gap-2.5 font-mono" onSelect={() => props.onViewport({ w, h })}>
            <Icon aria-hidden="true" />
            {w} × {h}
            {viewport !== 'fit' && viewport.w === w && viewport.h === h ? <CheckIcon className="ml-auto size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const readout = compact ? null : stats ? (
    <Stats stats={stats} shrunk={crowded} />
  ) : status ? (
    <span data-slot="preview-status" className="flex shrink-0 items-center gap-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground">
      <StatusDot tone={status.tone} aria-hidden="true" />
      {status.label}
    </span>
  ) : null

  const more = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="More">
          <EllipsisIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        {crowded && stats && !compact ? <DropdownMenuLabel className="font-mono text-xs font-normal text-muted-foreground">{statsText(stats)}</DropdownMenuLabel> : null}
        <DropdownMenuItem className="min-h-11 gap-2.5 md:min-h-0" disabled={!navEnabled} onSelect={() => props.onReload(true)}>
          <RefreshCwIcon aria-hidden="true" />
          Reload without cache
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 gap-2.5 md:min-h-0" disabled={url === ''} onSelect={props.onCopyUrl}>
          <LinkIcon aria-hidden="true" />
          Copy page URL
        </DropdownMenuItem>
        {current ? (
          <>
            <DropdownMenuSeparator />
            {adopted ? (
              <DropdownMenuItem disabled className="items-start gap-2.5 opacity-100 data-[disabled]:opacity-100">
                <LockIcon className="mt-0.5 text-muted-foreground" aria-hidden="true" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">{`Stop server · ${current.label} :${current.port}`}</span>
                  <span className="text-xs whitespace-normal text-muted-foreground">
                    cezar didn't start this server, so it won't stop it. Stop it where it was started.
                  </span>
                </span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem variant="destructive" className="min-h-11 gap-2.5 md:min-h-0" onSelect={() => props.onStop(current.port)}>
                <CircleStopIcon aria-hidden="true" />
                {`Stop server · ${current.label} :${current.port}`}
              </DropdownMenuItem>
            )}
          </>
        ) : null}
        {compact ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-11 gap-2.5" onSelect={props.onClose}>
              <XIcon aria-hidden="true" />
              Close preview
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const session = props.onSession ? (
    <Button variant="outline" size="sm" className="shrink-0 gap-1 max-md:h-11" onClick={props.onSession}>
      <ChevronLeftIcon aria-hidden="true" />
      Session
    </Button>
  ) : null

  const progress = loading ? (
    <div
      role="progressbar"
      aria-label="Loading the page"
      className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-transparent"
    >
      <div className="preview-progress h-full w-2/5 bg-success" />
    </div>
  ) : null

  if (compact) {
    return (
      <div data-slot="preview-toolbar" data-compact="" className="relative flex shrink-0 flex-col border-b border-border bg-background">
        <div className="flex items-center gap-2 px-2 pt-[max(0.25rem,env(safe-area-inset-top))]">
          {session}
          <div className="flex min-w-0 flex-1 flex-col items-center leading-tight">
            <span className="flex max-w-full items-center gap-1.5 text-sm font-semibold text-foreground">
              {stats ? <StatusDot tone="success" aria-hidden="true" /> : null}
              <span className="truncate">{current ? `${current.label} :${current.port}` : 'Preview'}</span>
            </span>
            {badge ? <span className="text-xs text-muted-foreground">Experimental</span> : null}
          </div>
          {more}
        </div>
        <div className="flex items-center gap-1 px-2 py-1">
          {back}
          {forward}
          {reload}
          {address}
        </div>
        {progress}
      </div>
    )
  }

  return (
    <div data-slot="preview-toolbar" className="relative flex shrink-0 items-center gap-1.5 border-b border-border bg-background px-2.5 py-2">
      {session}
      {back}
      {forward}
      {reload}
      {switcherMenu}
      {address}
      {viewportMenu}
      {readout}
      {badge ? <ExperimentalBadge iconOnly={crowded} /> : null}
      <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
      {more}
      <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="Close preview" onClick={props.onClose}>
        <XIcon aria-hidden="true" />
      </Button>
      {progress}
    </div>
  )
}
