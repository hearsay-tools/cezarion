import {
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  CopyIcon,
  DownloadIcon,
  FolderXIcon,
  HourglassIcon,
  InfoIcon,
  LoaderCircleIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  PlayIcon,
  PlugIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  UnplugIcon,
  WifiOffIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { PREVIEW_RECONNECTS } from '@/api/preview-socket'
import {
  type PreviewServer,
  type PreviewStateMessage,
} from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { ExperimentalBadge } from './experimental-badge'
import { LogTail } from './log-tail'
import { PreviewServerCard } from './server-card'
import type { ThreadPreviewServer } from '../thread-state'
import { entryFor, opensDirectly, serverScript, serverStatus } from './preview-state'
import { displayUrl } from './preview-url'

/**
 * The pane's states (design 5.1 to 5.18, minus the page itself and the toolbar's own readings).
 * Server stages arrive as `state` messages; connection lost (5.11), taken over (5.12) and proxy
 * blocked (5.14) are the cockpit's own transport states. Copy is the v1 design's, except where
 * the spec's "Design deltas" say otherwise (5.7).
 */

/** Where the sandbox and proxy limits are written down. */
export const PREVIEW_DOCS_URL = 'https://github.com/hearsay-tools/cezarion#environment-variables'

export type PreviewStageState =
  | Exclude<PreviewStateMessage, { stage: 'streaming' }>
  | { stage: 'proxy-blocked' }
  | { stage: 'taken-over'; by: string }

export interface PreviewStateActions {
  download(): void
  cancelDownload(): void
  retryBrowser(): void
  run(port: number): void
  stop(port: number): void
  keepWaiting(port: number): void
  close(): void
  useHere(): void
  copy(text: string): void
}

type StageProps<S extends PreviewStageState['stage']> = {
  state: Extract<PreviewStageState, { stage: S }>
  actions: PreviewStateActions
}

export function PreviewStates({
  state,
  actions,
  url,
  worktree,
}: {
  state: PreviewStageState
  actions: PreviewStateActions
  /** The page being opened, for 5.10. */
  url?: string
  /** The run's worktree path, for 5.15. */
  worktree?: string
}) {
  switch (state.stage) {
    case 'chromium-missing': return <ChromiumMissing state={state} actions={actions} />
    case 'downloading': return <Downloading state={state} actions={actions} />
    case 'download-failed': return <DownloadFailed state={state} actions={actions} />
    case 'sandbox-failed': return <SandboxFailed state={state} actions={actions} />
    case 'browser-exited': return <BrowserExited state={state} actions={actions} />
    case 'needs-approval': return <NeedsApproval state={state} actions={actions} />
    case 'port-held': return <PortHeld state={state} actions={actions} />
    case 'server-starting': return <ServerStarting state={state} actions={actions} />
    case 'server-stalled': return <ServerStalled state={state} actions={actions} />
    case 'server-exited': return <ServerExited state={state} actions={actions} />
    case 'server-stopped': return <ServerStopped state={state} actions={actions} />
    case 'loading': return <Loading step={state.step} url={url} />
    case 'worktree-removed': return <WorktreeRemoved state={state} actions={actions} worktree={worktree} />
    case 'proxy-blocked': return <ProxyBlocked actions={actions} />
    case 'taken-over': return <TakenOver state={state} actions={actions} />
  }
}

// ---- shell ------------------------------------------------------------------------------------

function Shell({
  icon,
  title,
  children,
  state,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
  state: string
}) {
  return (
    <div data-slot="preview-state" data-state={state} className="mx-auto flex h-full w-full max-w-[560px] flex-col justify-center gap-4 px-6 py-8">
      <div aria-hidden="true" className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-[18px]">
        {icon}
      </div>
      <h2 className="text-xl leading-tight font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  )
}

const Body = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>
const Actions = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap items-center gap-2">{children}</div>

function RunNote({ server }: { server: PreviewServer }) {
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <SquareTerminalIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{`Runs ${serverScript(server.command)} in this task's worktree, on the host.`}</span>
    </p>
  )
}

function CommandBlock({ copy, command, label }: { copy: (text: string) => void; command: string; label: string }) {
  return (
    <div data-slot="preview-install-command" className="min-w-0 rounded-lg bg-muted px-3.5 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs font-semibold tracking-wide text-soft-foreground uppercase">
        <span>{label}</span>
        <button
          type="button"
          aria-label="Copy command"
          className="-m-2 inline-flex size-11 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none md:m-0 md:size-6"
          onClick={() => copy(command)}
        >
          <CopyIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
      <code className="block font-mono text-sm break-words whitespace-pre-wrap text-foreground">{command}</code>
    </div>
  )
}

/** The registered server as 5.16 and 5.17 draw it: status, the exact command, cwd and what runs. */
function ApprovalBlock({ server, status }: { server: PreviewServer; status: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3.5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <StatusDot tone="neutral" shape="ring" aria-hidden="true" />
        <span className="font-semibold text-foreground">{server.label}</span>
        <span className="font-mono text-muted-foreground">:{server.port}</span>
        <span className="text-muted-foreground">{status}</span>
      </div>
      <div className="mt-2.5 min-w-0 rounded-md bg-muted px-3 py-2 font-mono text-xs">
        <p className="break-words whitespace-pre-wrap text-foreground">{server.command}</p>
        {server.cwd ? (
          <p className="mt-1 flex gap-3 text-soft-foreground">
            <span>cwd</span>
            <span className="break-all">{server.cwd}</span>
          </p>
        ) : null}
      </div>
      <div className="mt-2.5">
        <RunNote server={server} />
      </div>
    </div>
  )
}

// ---- browser ----------------------------------------------------------------------------------

function ChromiumMissing({ state, actions }: StageProps<'chromium-missing'>) {
  return (
    <Shell state={state.stage} icon={<DownloadIcon />} title="This host has no browser yet">
      <Body>
        {state.canDownload
          ? 'Preview runs Chromium on the machine cezar runs on. cezar can download it into ~/.cache/cez/ (about 150 MB). Nothing else on the host changes.'
          : 'Preview runs Chromium on the machine cezar runs on. cezar has no download for this platform, so install it with the system package manager.'}
      </Body>
      {state.canDownload ? (
        <Actions>
          <Button variant="contrast" onClick={actions.download}>
            <DownloadIcon aria-hidden="true" />
            Download Chromium
          </Button>
        </Actions>
      ) : null}
      <CommandBlock command={state.installCommand} copy={actions.copy} label={state.canDownload ? 'Or install it yourself' : 'Install it yourself'} />
    </Shell>
  )
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000)
}

function Downloading({ state, actions }: StageProps<'downloading'>) {
  const first = useRef<{ at: number; received: number } | null>(null)
  first.current ??= { at: Date.now(), received: state.received }
  const percent = state.total > 0 ? Math.min(100, Math.floor((state.received / state.total) * 100)) : 0
  const elapsed = (Date.now() - first.current.at) / 1000
  const rate = elapsed >= 1 ? (state.received - first.current.received) / elapsed : 0
  const left = rate > 0 ? Math.ceil((state.total - state.received) / rate) : undefined
  return (
    <Shell state={state.stage} icon={<DownloadIcon />} title="Downloading Chromium">
      <Body>Into ~/.cache/cez/, no root needed. Nothing else on the host changes.</Body>
      <div className="flex flex-col gap-1.5">
        <div
          role="progressbar"
          aria-label="Chromium download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="font-mono">{`${megabytes(state.received)} of ${megabytes(state.total)} MB · ${percent}%`}</span>
          {left !== undefined ? <span>{`about ${left} s left`}</span> : null}
        </div>
      </div>
      <Actions>
        <Button variant="outline" onClick={actions.cancelDownload}>Cancel</Button>
      </Actions>
    </Shell>
  )
}

function DownloadFailed({ state, actions }: StageProps<'download-failed'>) {
  return (
    <Shell state={state.stage} icon={<TriangleAlertIcon className="text-danger" />} title="Couldn't download Chromium">
      <Body>{`${state.error.replace(/\.$/, '')}. Install Chromium with the system package manager, then retry.`}</Body>
      <CommandBlock command={state.installCommand} copy={actions.copy} label="Install it yourself" />
      <Actions>
        <Button variant="contrast" onClick={actions.download}>
          <RotateCcwIcon aria-hidden="true" />
          Retry download
        </Button>
        <Button variant="outline" onClick={() => actions.copy(`Chromium download failed\n${state.error}\nInstall: ${state.installCommand}`)}>
          <CopyIcon aria-hidden="true" />
          Copy diagnostics
        </Button>
      </Actions>
    </Shell>
  )
}

function SandboxFailed({ state, actions }: StageProps<'sandbox-failed'>) {
  return (
    <Shell state={state.stage} icon={<ShieldAlertIcon className="text-danger" />} title="Chromium couldn't start its sandbox">
      <Body>The host blocks the sandbox Chromium needs. This usually means cezar runs as root, or inside a container without user namespaces.</Body>
      <LogTail text={state.stderrTail} source="chromium" onCopy={actions.copy} />
      <Actions>
        <Button variant="contrast" onClick={actions.retryBrowser}>
          <RotateCcwIcon aria-hidden="true" />
          Retry
        </Button>
        <Button variant="outline" onClick={() => actions.copy(`Chromium failed to start its sandbox\n${state.stderrTail}`)}>
          <CopyIcon aria-hidden="true" />
          Copy diagnostics
        </Button>
      </Actions>
      <a className="text-sm font-medium text-accent-text underline-offset-2 hover:underline" href={PREVIEW_DOCS_URL} target="_blank" rel="noopener noreferrer">
        Docs: running without the sandbox (CEZ_PREVIEW_NO_SANDBOX=1)
      </a>
    </Shell>
  )
}

function BrowserExited({ state, actions }: StageProps<'browser-exited'>) {
  return (
    <Shell state={state.stage} icon={<CircleXIcon className="text-danger" />} title="The browser stopped">
      <Body>
        {`Chromium exited unexpectedly${state.signal ? ` (${state.signal})` : ''}. ${
          state.serverUp ? 'The dev server is still up; only the browser needs a restart.' : 'The browser needs a restart.'
        }`}
      </Body>
      <LogTail text={state.stderrTail} source="chromium" onCopy={actions.copy} />
      <Actions>
        <Button variant="contrast" onClick={actions.retryBrowser}>
          <RotateCcwIcon aria-hidden="true" />
          Retry
        </Button>
        <Button variant="outline" onClick={() => actions.copy(`Chromium exited${state.signal ? ` (${state.signal})` : ''}\n${state.stderrTail}`)}>
          <CopyIcon aria-hidden="true" />
          Copy diagnostics
        </Button>
      </Actions>
    </Shell>
  )
}

// ---- dev server -------------------------------------------------------------------------------

/** The dev server is probed this often (PREVIEW_PROBE_MS) while it starts. */
const PROBE_SECONDS = 2

/** Re-renders every `ms` so "6 s ago" stays true. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

function NeedsApproval({ state, actions }: StageProps<'needs-approval'>) {
  const { server, wasRunning } = state
  return (
    <Shell
      state={state.stage}
      icon={wasRunning ? <UnplugIcon className="text-pending-strong" /> : <PlayIcon />}
      title={wasRunning ? `Nothing answers on :${server.port} anymore` : `${server.label} isn't running yet`}
    >
      <Body>
        {wasRunning
          ? `${server.label} was running when the agent registered it, likely inside the agent's own session, which has ended. cezar can start it with the registered command.`
          : 'The agent registered this server. Nothing runs until you approve it here.'}
      </Body>
      <ApprovalBlock server={server} status={wasRunning ? 'was running when registered · silent now' : 'registered · not started'} />
      <Actions>
        <Button variant="contrast" onClick={() => actions.run(server.port)}>
          <PlayIcon aria-hidden="true" />
          Run and open
        </Button>
      </Actions>
    </Shell>
  )
}

function PortHeld({ state, actions }: StageProps<'port-held'>) {
  const { server, ownerTitle } = state
  return (
    <Shell state={state.stage} icon={<TriangleAlertIcon className="text-pending-strong" />} title={`${server.label} :${server.port} is in use by another task`}>
      <Body>{`Task "${ownerTitle}" is running its own server on :${server.port}. Register a different port for this task, or stop that task's server.`}</Body>
      <Actions>
        <Button variant="contrast" onClick={actions.close}>Close preview</Button>
      </Actions>
    </Shell>
  )
}

function ServerStarting({ state, actions }: StageProps<'server-starting'>) {
  const { server } = state
  const now = useNow(1000)
  const seconds = Math.max(0, Math.floor((now - Date.parse(state.startedAt)) / 1000))
  // The host probes every PREVIEW_PROBE_MS; each report restarts the countdown to the next try.
  const [reportedAt, setReportedAt] = useState(() => Date.now())
  useEffect(() => setReportedAt(Date.now()), [state.attempt])
  const nextIn = Math.max(0, Math.ceil(PROBE_SECONDS - (now - reportedAt) / 1000))
  return (
    <Shell state={state.stage} icon={<PlayIcon />} title={`Starting ${server.label}`}>
      <Body>{`cezar ran ${serverScript(server.command)} in the worktree. The page opens as soon as :${server.port} answers.`}</Body>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-3 text-sm">
        <span className="flex items-center gap-2.5 font-semibold text-foreground">
          <LoaderCircleIcon className="size-4 animate-spin text-success motion-reduce:animate-none" aria-hidden="true" />
          {nextIn > 0 ? `Attempt ${state.attempt} · next try in ${nextIn} s` : `Attempt ${state.attempt}`}
        </span>
        <span className="text-xs text-muted-foreground">{`started ${seconds} s ago`}</span>
      </div>
      {state.logTail.length > 0 ? <LogTail text={state.logTail.join('\n')} source={serverScript(server.command)} onCopy={actions.copy} /> : null}
      <Actions>
        <Button variant="outline" onClick={() => actions.stop(server.port)}>Stop server</Button>
      </Actions>
    </Shell>
  )
}

function ServerStalled({ state, actions }: StageProps<'server-stalled'>) {
  const { server } = state
  return (
    <Shell state={state.stage} icon={<HourglassIcon className="text-pending-strong" />} title={`${server.label} is running, but :${server.port} is silent`}>
      {/* Spec "Design deltas": dev servers get no stdin, so this stage is never a prompt. */}
      <Body>The process has run for 2 min without opening the port. It may be waiting on another service, or listening somewhere else.</Body>
      <LogTail text={state.logTail} source={serverScript(server.command)} onCopy={actions.copy} />
      <Actions>
        <Button variant="contrast" onClick={() => actions.keepWaiting(server.port)}>Keep waiting</Button>
        <Button variant="outline" onClick={() => actions.stop(server.port)}>Stop server</Button>
      </Actions>
    </Shell>
  )
}

function ServerExited({ state, actions }: StageProps<'server-exited'>) {
  const { server } = state
  return (
    <Shell
      state={state.stage}
      icon={<CircleXIcon className="text-danger" />}
      title={state.exitCode === null ? `${server.label} was stopped by a signal` : `${server.label} exited with code ${state.exitCode}`}
    >
      <Body>{`${serverScript(server.command)} stopped.`}</Body>
      <LogTail text={state.logTail} source={serverScript(server.command)} onCopy={actions.copy} />
      <Actions>
        <Button variant="contrast" onClick={() => actions.run(server.port)}>
          <RotateCcwIcon aria-hidden="true" />
          Start again
        </Button>
      </Actions>
      <RunNote server={server} />
    </Shell>
  )
}

function ServerStopped({ state, actions }: StageProps<'server-stopped'>) {
  const { server } = state
  const idle = state.reason === 'idle'
  return (
    <Shell state={state.stage} icon={<MoonIcon />} title={idle ? 'Stopped after 15 min idle' : `${server.label} stopped`}>
      <Body>
        {idle
          ? `Nobody had this pane open for 15 min, so cezar stopped ${server.label} :${server.port} and the browser to free memory. Start again reopens ${displayUrl(state.lastUrl)}.`
          : `You stopped ${server.label} :${server.port}. Start again reopens ${displayUrl(state.lastUrl)}.`}
      </Body>
      <Actions>
        <Button variant="contrast" onClick={() => actions.run(server.port)}>
          <RotateCcwIcon aria-hidden="true" />
          Start again
        </Button>
      </Actions>
      <RunNote server={server} />
    </Shell>
  )
}

// ---- first open -------------------------------------------------------------------------------

const STEPS = ['browser', 'page', 'frame'] as const

function Loading({ step, url }: { step: (typeof STEPS)[number]; url: string | undefined }) {
  const at = STEPS.indexOf(step)
  const page = url ? displayUrl(url) : 'the page'
  const rows: Array<{ done: string; active: string }> = [
    { done: 'Browser started', active: 'Starting the browser' },
    { done: `Opened ${page}`, active: `Opening ${page}` },
    { done: 'First frame', active: 'First frame' },
  ]
  return (
    <div data-slot="preview-state" data-state="loading" className="mx-auto flex h-full w-full max-w-[560px] flex-col justify-center px-6 py-8">
      <ol aria-label="Opening the page" className="mx-auto flex flex-col gap-4 text-sm">
        {rows.map((row, index) => {
          const done = index < at
          const active = index === at
          return (
            <li key={index} aria-current={active ? 'step' : undefined} className={cn('flex items-center gap-3', active ? 'font-semibold text-foreground' : done ? 'text-foreground' : 'text-soft-foreground')}>
              {done ? (
                <CircleCheckIcon className="size-5 text-success" aria-hidden="true" />
              ) : active ? (
                <LoaderCircleIcon className="size-5 animate-spin text-success motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <CircleIcon className="size-5 text-border" aria-hidden="true" />
              )}
              {done ? row.done : active ? row.active : row.done}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ---- gone -------------------------------------------------------------------------------------

function WorktreeRemoved({ state, actions, worktree }: StageProps<'worktree-removed'> & { worktree?: string }) {
  const where = worktree ? /\.ai\/cezar\/worktrees\/[^/]+/.exec(worktree)?.[0] : undefined
  const label = state.server?.label
  return (
    <Shell state={state.stage} icon={<FolderXIcon />} title="This task's worktree is gone">
      <Body>
        {`${label ?? 'The server'} ran in ${where ?? "this task's worktree"}, which has been removed. There is nothing left to start.`}
      </Body>
      {state.server ? (
        <PreviewServerCard entry={{ kind: 'preview-server', id: `preview-server:${state.server.port}`, server: state.server, state: 'unavailable' }} inPreview={false} />
      ) : null}
      <Actions>
        <Button variant="outline" onClick={actions.close}>Close preview</Button>
      </Actions>
    </Shell>
  )
}

// ---- transport (cockpit side) -----------------------------------------------------------------

function ProxyBlocked({ actions }: { actions: PreviewStateActions }) {
  return (
    <div data-slot="preview-state" data-state="proxy-blocked" className="mx-auto flex h-full w-full max-w-[560px] flex-col justify-center gap-4 px-6 py-8">
      <div><ExperimentalBadge /></div>
      <div aria-hidden="true" className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-[18px]">
        <PlugIcon />
      </div>
      <h2 className="text-xl leading-tight font-semibold text-foreground">Preview doesn't work behind this proxy yet</h2>
      <Body>The proxy in front of cezar didn't let the preview's WebSocket through. This is a known gap behind Basic Auth. Everything else in cezar keeps working.</Body>
      <Actions>
        <Button variant="outline" onClick={actions.close}>Close preview</Button>
        <a className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text underline-offset-2 hover:underline" href={PREVIEW_DOCS_URL} target="_blank" rel="noopener noreferrer">
          Which setups work
        </a>
      </Actions>
    </div>
  )
}

/** `Safari on iPhone`, from the user agent the server saw. Empty when it cannot tell. */
export function describeViewer(userAgent: string): string {
  const os = /iPhone/.test(userAgent) ? 'iPhone'
    : /iPad/.test(userAgent) ? 'iPad'
    : /Android/.test(userAgent) ? 'Android'
    : /Windows/.test(userAgent) ? 'Windows'
    : /Mac OS X|Macintosh/.test(userAgent) ? 'Mac'
    : /Linux|X11/.test(userAgent) ? 'Linux'
    : ''
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Firefox\/|FxiOS/.test(userAgent) ? 'Firefox'
    : /Chrome\/|CriOS/.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : ''
  return browser && os ? `${browser} on ${os}` : browser || os
}

function TakenOver({ state, actions }: StageProps<'taken-over'>) {
  const who = describeViewer(state.by)
  return (
    <Shell state={state.stage} icon={<MonitorSmartphoneIcon />} title="Preview is open somewhere else">
      <Body>{`Another tab took this browser${who ? ` (${who})` : ''}. Only one tab can view and drive it at a time.`}</Body>
      <Actions>
        <Button variant="contrast" onClick={actions.useHere}>
          <DownloadIcon aria-hidden="true" />
          Use it here
        </Button>
        <Button variant="outline" onClick={actions.close}>Close preview</Button>
      </Actions>
    </Shell>
  )
}

/** 5.11: the last frame stays, dimmed, under this banner. Input is ignored until frames return. */
export function ConnectionBanner({ attempt, exhausted, onReconnect }: { attempt: number; exhausted: boolean; onReconnect: () => void }) {
  return (
    <div
      data-slot="preview-connection-banner"
      role="status"
      className="absolute inset-x-3 top-3 z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm shadow-sm"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <WifiOffIcon className="size-4 shrink-0 text-danger" aria-hidden="true" />
        <span>
          <strong className="font-semibold text-foreground">Lost the connection to the host</strong>
          {exhausted ? null : <span className="text-muted-foreground">{` · reconnecting (attempt ${attempt} of ${PREVIEW_RECONNECTS})`}</span>}
        </span>
      </span>
      <Button variant="outline" onClick={onReconnect}>{exhausted ? 'Reconnect' : 'Reconnect now'}</Button>
    </div>
  )
}

// ---- empty ------------------------------------------------------------------------------------

/** Design 04: nothing open yet. Lists the task's registered servers; nothing here runs anything. */
export function PreviewEmptyState({
  servers,
  states,
  onOpen,
}: {
  servers: readonly PreviewServer[]
  /** Where each server stands now; a server missing here reads as just registered. */
  states?: ReadonlyMap<number, ThreadPreviewServer>
  onOpen: (port: number) => void
}) {
  return (
    <div data-slot="preview-state" data-state="empty" className="mx-auto flex h-full w-full max-w-[560px] flex-col justify-center gap-4 px-6 py-8">
      <h2 className="text-xl leading-tight font-semibold text-foreground">Open a page in this task's browser</h2>
      <Body>The browser runs on the host, next to the worktree. Type a URL, a bare port such as 3000, or open a server the agent registered.</Body>
      {servers.length > 0 ? (
        <section aria-labelledby="preview-registered" className="overflow-hidden rounded-lg border border-border bg-card">
          <h3 id="preview-registered" className="border-b border-border px-3.5 py-2.5 text-xs font-semibold tracking-wide text-soft-foreground uppercase">
            Registered in this task
          </h3>
          <ul>
            {servers.map(server => {
              const entry = entryFor(server, states)
              const look = serverStatus(entry)
              return (
                <li key={server.port} className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2 text-sm last:border-b-0">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
                    <StatusDot tone={look.tone} shape={look.ring ? 'ring' : 'filled'} pulse={look.pulse} aria-hidden="true" />
                    <span className="font-semibold text-foreground">{server.label}</span>
                    <span className="font-mono text-muted-foreground">:{server.port}</span>
                    <span className="text-muted-foreground">{look.text}</span>
                  </span>
                  <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => onOpen(server.port)}>
                    {opensDirectly(entry) ? 'Open' : 'Review'}
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Review opens a server's approval in this pane: its command, cwd and Run and open. Nothing runs from this list. Paste works; copying text out, file pickers and downloads don't yet.
        </span>
      </p>
    </div>
  )
}
