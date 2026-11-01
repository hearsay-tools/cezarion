import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CircleStopIcon,
  EllipsisIcon,
  GaugeIcon,
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
import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'

import type { PreviewQuality, PreviewServer } from '@open-mercato/cezar-api-client'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import { ExperimentalBadge } from './experimental-badge'
import { PREVIEW_QUALITIES, qualityLabel, toPreviewQuality } from './preview-quality'
import { entryFor, serverStatus } from './preview-state'
import { displayUrl } from './preview-url'
import type { ThreadPreviewServer } from '../thread-state'

/**
 * The pane's toolbar (design 04, 4.1 to 4.3 and the mobile frame). Order: Session (only where the
 * pane replaces the transcript), back, forward, reload, server switcher (two or more entries: the
 * registered servers and, while an agent drives the browser, the agent's page),
 * address, viewport, stream quality, stats, Experimental badge, More, close. On a phone the
 * quality choice moves into More, next to close.
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
  /** The registered server being shown. Absent for a typed URL and the agent's page. */
  current?: PreviewServer | undefined
  /** An agent drives the task's browser now: the switcher lists its page (hearsay-tools/cezarion#784). */
  agentLive?: boolean
  /** The pane shows the agent's page. */
  agentShown?: boolean
  /** The page comes from a server cezar did not start (5.18). */
  adopted: boolean
  viewport: PreviewViewport
  /** The stream's JPEG quality (hearsay-tools/cezarion#2066). */
  quality: PreviewQuality
  /** A phone: two rows, no viewport menu, no stats, close inside More. */
  compact?: boolean
  /** A page is streaming, so back, forward and reload mean something. */
  navEnabled: boolean
  /** First open in progress (5.10): the thin bar under the toolbar. */
  loading?: boolean
  /** Where each registered server stands now; a server missing here reads as just registered. */
  serverStates?: ReadonlyMap<number, ThreadPreviewServer> | undefined
  /** The Experimental badge. False where the stage carries it instead (5.14). */
  badge?: boolean
  /** Present while frames flow. */
  stats?: PreviewStatsValue | undefined
  /** Shown in the stats' place when nothing streams: `server exited`, `offline`, `not started`. */
  status?: { tone: StatusDotTone; label: string } | undefined
  urlInputRef?: RefObject<HTMLInputElement | null>
  /** Set where the pane replaces the transcript; the control returns to it. */
  onSession?: (() => void) | undefined
  onNavigate: (input: string) => void
  onBack: () => void
  onForward: () => void
  onReload: (ignoreCache: boolean) => void
  onPickServer: (port: number) => void
  onPickAgent?: (() => void) | undefined
  onViewport: (viewport: PreviewViewport) => void
  onQuality: (quality: PreviewQuality) => void
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
    // The words go first when the toolbar is narrow (a container query): the dot stays, and the
    // numbers stay readable through the accessible name and More.
    <span
      data-slot="preview-stats"
      role="img"
      aria-label={idle ? 'idle' : statsText(stats)}
      className="flex shrink-0 items-center gap-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground"
    >
      <StatusDot tone={idle ? 'neutral' : 'success'} aria-hidden="true" />
      {/* One reserved width (the longest reading, "60 fps · 9999 KB/s · 999 ms"), live or idle:
          a reading that changes length must not shift the URL field and the controls beside it. */}
      <span className="hidden @min-[640px]:inline-block w-[28ch] overflow-hidden text-ellipsis">{idle ? 'idle' : statsText(stats)}</span>
    </span>
  )
}

/** The switcher's trigger: the server shown, the agent's page, or neither (a typed URL). */
function SwitcherButton({ current, agentShown, ...rest }: { current: PreviewServer | undefined; agentShown: boolean } & ComponentProps<typeof Button>) {
  const name = current ? current.label : agentShown ? "Agent's page" : 'Server'
  return (
    <Button
      variant="outline"
      size="sm"
      className="max-w-[11rem] min-w-0 gap-1.5 max-md:h-11"
      aria-label={current ? `Server: ${current.label} :${current.port}` : agentShown ? `Server: ${name}` : 'Server'}
      {...rest}
    >
      {current || agentShown ? <StatusDot tone="neutral" shape="ring" aria-hidden="true" /> : <ServerIcon aria-hidden="true" />}
      <span className="truncate">{name}</span>
      {current ? <span className="font-mono font-normal text-muted-foreground">:{current.port}</span> : null}
      <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
    </Button>
  )
}

/** The switcher's entry for the page an agent drives (hearsay-tools/cezarion#784). */
function AgentPageItem({ shown, live, onSelect }: { shown: boolean; live: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem className="min-h-11 gap-2.5 md:min-h-0" onSelect={onSelect}>
      <StatusDot tone={live ? 'success' : 'neutral'} aria-hidden="true" />
      <span className="font-semibold">Agent's page</span>
      <span className="ml-auto text-xs text-muted-foreground">agent-browser</span>
      {shown ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
    </DropdownMenuItem>
  )
}

/** The mobile toolbar's title. */
function shownTitle(current: PreviewServer | undefined, agentShown: boolean): string {
  if (current) return `${current.label} :${current.port}`
  return agentShown ? "Agent's page" : 'Preview'
}

/**
 * The switcher's "Agent's page" entry. An agent that left keeps it while the pane still shows its
 * page, so the servers stay one pick away.
 */
function agentEntry(props: PreviewToolbarProps): { agentLive: boolean; agentShown: boolean; agentListed: boolean } {
  const pickable = props.onPickAgent !== undefined
  const agentLive = props.agentLive === true && pickable
  const agentShown = props.agentShown === true
  return { agentLive, agentShown, agentListed: agentLive || (agentShown && pickable) }
}

export function PreviewToolbar(props: PreviewToolbarProps) {
  const { compact = false, navEnabled, loading = false } = props
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

  const address = <ToolbarAddress props={props} input={input} draft={draft} setDraft={setDraft} focused={focused} setFocused={setFocused} />
  const { agentListed } = agentEntry(props)
  const switcher = props.servers.length + (agentListed ? 1 : 0) >= 2
  const crowded = switcher || props.adopted
  const more = <ToolbarMore props={props} compact={compact} crowded={crowded} />
  const elements = { back, forward, reload, address, more, session, progress }
  return compact
    ? <MobileToolbar props={props} elements={elements} />
    : <DesktopToolbar props={props} elements={elements} switcher={switcher} crowded={crowded} input={input} focusUrlAfterMenu={focusUrlAfterMenu} />
}

interface ToolbarElements {
  back: ReactNode
  forward: ReactNode
  reload: ReactNode
  address: ReactNode
  more: ReactNode
  session: ReactNode
  progress: ReactNode
}

interface ToolbarInput {
  input: RefObject<HTMLInputElement | null>
  focusUrlAfterMenu: RefObject<boolean>
}

function ToolbarSwitcher({ props, input, focusUrlAfterMenu }: { props: PreviewToolbarProps } & ToolbarInput) {
  const { servers, current } = props
  const { agentLive, agentShown, agentListed } = agentEntry(props)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SwitcherButton current={current} agentShown={agentShown} />
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
        {agentListed ? <AgentPageItem shown={agentShown} live={agentLive} onSelect={() => props.onPickAgent?.()} /> : null}
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
  )
}

function ToolbarAddress({ props, input, draft, setDraft, focused, setFocused }: {
  props: PreviewToolbarProps
  input: RefObject<HTMLInputElement | null>
  draft: string | null
  setDraft(value: string | null): void
  focused: boolean
  setFocused(value: boolean): void
}) {
  const { url, adopted } = props
  return (
    <div className="relative flex min-w-[9rem] flex-1 items-center">
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
}

function ToolbarViewport({ props }: { props: PreviewToolbarProps }) {
  const { viewport } = props
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" aria-label={`Viewport size: ${viewportLabel(viewport)}`}>
          {viewport === 'fit' ? <MaximizeIcon aria-hidden="true" /> : <MonitorIcon aria-hidden="true" />}
          <span className={cn('hidden @min-[500px]:inline', viewport !== 'fit' && 'font-mono font-normal')}>{viewportLabel(viewport)}</span>
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
}

/** Normal, High and Ultra as one radio group, for the toolbar menu and the phone's More. */
function QualityOptions({ quality, onQuality, compact }: { quality: PreviewQuality; onQuality: (quality: PreviewQuality) => void; compact: boolean }) {
  return (
    <DropdownMenuRadioGroup value={quality} onValueChange={value => onQuality(toPreviewQuality(value))}>
      {PREVIEW_QUALITIES.map(option => (
        <DropdownMenuRadioItem key={option.value} value={option.value} data-quality={option.value} className={cn('items-start', compact && 'min-h-11')}>
          <span className="flex flex-col gap-0.5">
            <span>{option.label}</span>
            <span className="text-xs whitespace-normal text-muted-foreground">{option.detail}</span>
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

function ToolbarQuality({ props }: { props: PreviewToolbarProps }) {
  const { quality } = props
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" aria-label={`Stream quality: ${qualityLabel(quality)}`}>
          <GaugeIcon aria-hidden="true" />
          {/* After the viewport's label: the narrower pane drops this one first. */}
          <span className="hidden @min-[560px]:inline">{qualityLabel(quality)}</span>
          <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Stream quality</DropdownMenuLabel>
        <QualityOptions quality={quality} onQuality={props.onQuality} compact={false} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ToolbarReadout({ stats, status, crowded }: Pick<PreviewToolbarProps, 'stats' | 'status'> & { crowded: boolean }) {
  return stats ? (
    <Stats stats={stats} shrunk={crowded} />
  ) : status ? (
    <span data-slot="preview-status" className="flex shrink-0 items-center gap-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground">
      <StatusDot tone={status.tone} aria-hidden="true" />
      {status.label}
    </span>
  ) : null
}

function ToolbarMore({ props, compact, crowded }: { props: PreviewToolbarProps; compact: boolean; crowded: boolean }) {
  const { stats, navEnabled, url, current, adopted } = props
  return (
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
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Stream quality</DropdownMenuLabel>
            <QualityOptions quality={props.quality} onQuality={props.onQuality} compact />
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
}

function MobileToolbar({ props, elements }: { props: PreviewToolbarProps; elements: ToolbarElements }) {
  const { stats, current, badge = true } = props
  const { agentShown } = agentEntry(props)
  const { back, forward, reload, address, more, session, progress } = elements
  return (
    <div data-slot="preview-toolbar" data-compact="" className="relative flex shrink-0 flex-col border-b border-border bg-background">
      <div className="flex items-center gap-2 px-2 pt-[max(0.25rem,env(safe-area-inset-top))]">
        {session}
        <div className="flex min-w-0 flex-1 flex-col items-center leading-tight">
          <span className="flex max-w-full items-center gap-1.5 text-sm font-semibold text-foreground">
            {stats ? <StatusDot tone="success" aria-hidden="true" /> : null}
            <span className="truncate">{shownTitle(current, agentShown)}</span>
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

function DesktopToolbar({ props, elements, switcher, crowded, input, focusUrlAfterMenu }: {
  props: PreviewToolbarProps
  elements: ToolbarElements
  switcher: boolean
  crowded: boolean
} & ToolbarInput) {
  const { badge = true, stats, status } = props
  const { back, forward, reload, address, more, session, progress } = elements

  return (
    <div data-slot="preview-toolbar" className="@container relative flex shrink-0 items-center gap-1.5 border-b border-border bg-background px-2.5 py-2">
      {session}
      {back}
      {forward}
      {reload}
      {switcher ? <ToolbarSwitcher props={props} input={input} focusUrlAfterMenu={focusUrlAfterMenu} /> : null}
      {address}
      <ToolbarViewport props={props} />
      <ToolbarQuality props={props} />
      <ToolbarReadout stats={stats} status={status} crowded={crowded} />
      {badge ? <ExperimentalBadge iconOnly={crowded} responsive={!crowded} /> : null}
      <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
      {more}
      <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="Close preview" onClick={props.onClose}>
        <XIcon aria-hidden="true" />
      </Button>
      {progress}
    </div>
  )
}
