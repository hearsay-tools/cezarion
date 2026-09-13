import { ChevronDownIcon, TerminalIcon } from '@/components/design-icons'

import { useRef, type ComponentProps } from 'react'
import { DefaultAgentPicker } from '@/components/default-agent-picker'

/** Settings presents the shared authenticated account choices in a compact disclosure.
 * Selection still goes through the shared picker, including its per-account write guards. */
export function SettingsAgentPicker(props: ComponentProps<typeof DefaultAgentPicker>) {
  const disclosure = useRef<HTMLDetailsElement>(null)
  const selected = props.rows.find((row) => row.runner.id === props.runner && row.account === props.accountFor(row.runner.id))
  return (
    <details ref={disclosure} className="settings-agent-picker">
      <summary>
        <TerminalIcon aria-hidden="true" className="size-4 text-accent-text" />
        <span className="min-w-0 flex-1">{(selected?.label ?? props.runner).replace(/^codex/, 'Codex').replace(/^claude/, 'Claude Code')}</span>
        <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      </summary>
      <DefaultAgentPicker {...props} onPick={(...args) => {
        props.onPick(...args)
        if (disclosure.current) disclosure.current.open = false
      }} />
    </details>
  )
}
