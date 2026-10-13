import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cliOf } from '@/lib/automation-cli'

import type { AutomationDraft } from './editor-draft'

/**
 * "Copy as CLI" (#774, port of upstream #985): what the form holds, as the `cez automation` line
 * that would create it — the flag form when every key has a flag, the JSON form otherwise. Built
 * from the body Save sends (`cliOf` → `toCreateBody`), so the two cannot disagree.
 */
export function CopyAsCliCard({ draft }: { draft: AutomationDraft }) {
  const line = useMemo(() => cliOf(draft), [draft])
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  // A new line is not the one that was copied.
  useEffect(() => setState('idle'), [line])

  const copy = async () => {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(line)
      setState('copied')
      timer.current = setTimeout(() => setState('idle'), 1600)
    } catch {
      setState('failed')
    }
  }

  return (
    <section aria-labelledby="copy-as-cli-heading" data-slot="copy-as-cli" className="mbs-4 rounded-xl border bg-card p-4">
      <div className="mbe-2 flex items-center gap-2">
        <h2 id="copy-as-cli-heading" className="text-[15px] font-medium">Copy as CLI</h2>
        <Button type="button" variant="ghost" size="sm" className="ms-auto" onClick={() => void copy()}>
          {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {state === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="m-0 rounded-lg border bg-muted px-2.5 py-2 font-mono text-xs/relaxed break-words whitespace-pre-wrap text-muted-foreground">{line}</pre>
      <p role="status" className="mbs-2 text-xs break-words text-muted-foreground">
        {state === 'failed'
          ? 'Could not copy — select the line and copy it by hand.'
          : <>The definition Save would create. <code>cez automation schema</code> prints its shape.</>}
      </p>
    </section>
  )
}
