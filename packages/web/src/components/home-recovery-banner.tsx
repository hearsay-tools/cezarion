import type { HomeRecoveryFile } from '@open-mercato/cezar-api-client/contract/home-recovery'
import { useAcceptHomeRecovery, useHomeRecovery, useRestoreHomeRecovery } from '@/api/home-recovery'
import { Button } from '@/components/ui/button'

function recoveryMessage(file: HomeRecoveryFile): string {
  if (file.reason === 'outside-write') return `${file.file} changed outside Cezar. Restore the previous version or accept the file as found.`
  return file.file === 'config.json'
    ? 'The project registry was reset. Restore the previous projects?'
    : 'The account list was reset. Restore the previous accounts?'
}

function HomeRecoveryRow({ file }: { file: HomeRecoveryFile }) {
  const restore = useRestoreHomeRecovery()
  const accept = useAcceptHomeRecovery()
  const busy = restore.isPending || accept.isPending
  const error = restore.error ?? accept.error
  const run = (action: 'restore' | 'accept') => {
    restore.reset()
    accept.reset()
    if (action === 'restore') restore.mutate(file.file)
    else accept.mutate(file.file)
  }
  return (
    <div data-slot="home-recovery" data-home-file={file.file} role="status" aria-live="polite" aria-busy={busy}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/50 p-3 text-sm text-foreground">
      <span className="flex-[1_1_24rem] [min-inline-size:0] [overflow-wrap:break-word]">{recoveryMessage(file)}</span>
      <div className="flex flex-wrap gap-2">
        <Button type="button" data-action="restore" disabled={busy || !file.canRestore} onClick={() => run('restore')}>Restore</Button>
        <Button type="button" variant="outline" data-action="accept" disabled={busy} onClick={() => run('accept')}>Accept as found</Button>
      </div>
      {error && <p role="alert" className="basis-full text-danger">{error.message}</p>}
    </div>
  )
}

/** Empty successful state remains observable without adding a visible banner or placeholder. */
export function HomeRecoveryBanner() {
  const recovery = useHomeRecovery()
  return (
    <div data-slot="home-recovery-state" data-state={recovery.isSuccess ? 'ready' : recovery.isError ? 'error' : 'pending'}>
      {recovery.data?.files.map(file => <HomeRecoveryRow key={file.file} file={file} />)}
    </div>
  )
}
