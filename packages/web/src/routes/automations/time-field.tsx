import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'

const pad = (n: number) => String(n).padStart(2, '0')

/** A two-digit clock field. It holds its own text while typing — "7" is not yet "07" — and
 *  commits to the schedule only a value in range; blur settles it back to the committed value.
 *  Text that is not the committed value ("24", "7x") is invalid until fixed or blurred: the field
 *  says so and its custom validity blocks the form, so Enter cannot save a time nobody typed. */
export function TimeField({ label, value, max, onCommit }: { label: string; value: number; max: number; onCommit: (next: number) => void }) {
  const [text, setText] = useState(pad(value))
  const ref = useRef<HTMLInputElement>(null)
  const invalid = !(/^\d{1,2}$/.test(text) && Number(text) === value)
  const message = `${label} must be 00–${pad(max)}.`
  const messageId = useId()
  useEffect(() => { ref.current?.setCustomValidity(invalid ? message : '') }, [invalid, message])
  return (
    <>
      <Input
        ref={ref}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? messageId : undefined}
        inputMode="numeric"
        maxLength={2}
        className="w-20 text-center tabular-nums"
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          if (/^\d{1,2}$/.test(event.target.value) && Number(event.target.value) <= max) onCommit(Number(event.target.value))
        }}
        onBlur={() => setText(pad(value))}
      />
      {invalid ? <p id={messageId} className="order-last basis-full text-xs text-destructive">{message}</p> : null}
    </>
  )
}
