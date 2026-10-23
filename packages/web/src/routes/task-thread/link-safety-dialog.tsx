import type { LinkSafetyModalProps } from 'streamdown'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * Portalled confirmation for transcript links. Keep the full destination and explicit
 * confirmation; contained thread rows must not position or clip the dialog. Preserve the
 * renderer’s confirm/close callbacks.
 */
export function LinkSafetyDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent data-slot="link-safety-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Open this link?</AlertDialogTitle>
          {/* The address rides INSIDE the description on purpose: Radix points the dialog's
              `aria-describedby` at this node, and the address is the whole reason the prompt
              exists — a screen reader that announced only the sentence would leave its user
              with exactly the question the dialog was opened to answer. A <span> (block only
              by CSS) because the description renders a <p>, which cannot contain a <div>. */}
          <AlertDialogDescription>
            It leaves cezar in a new tab. The words of a link in a transcript are the
            agent&apos;s — the address below is where it actually goes.
            {/* The full URL, never truncated: a shortened address is exactly the one a reader
                cannot check. `wrap-anywhere` keeps a long one inside the dialog. */}
            <span
              data-slot="link-safety-url"
              className="mt-3 block wrap-anywhere rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground"
            >
              {url}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* Streamdown's `onConfirm` is the one that opens the tab (`_blank`, `noreferrer`);
              the Action also closes the dialog, which is what fires `onClose`. */}
          <AlertDialogAction onClick={onConfirm}>Open link</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
