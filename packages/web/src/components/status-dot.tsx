import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { BotIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/* The 7px status dot — the design system's single carrier of status color.
 * Rows, pills and nav items stay neutral; the dot is what's tinted. See the mockups' `.dot-*` classes.
 * `pulse` marks a transitioning state (running / waiting) and uses Tailwind's stock `animate-pulse`
 * rather than a bespoke keyframe, per the design system's "quiet motion" rule.
 *
 * `shape` is the status key's second channel (#617): hue says the family, shape says whether it is
 * waiting. `filled` — moving or ended; `ring` — the same 7px box as a 1.5px stroke with a clear
 * centre, waiting on something outside it; `workers` — lucide's 12px `bot` glyph, waiting on its own
 * workers. The tone maps to a fill, a stroke or an ink depending on the shape, so one tone name
 * paints all three.
 */
const statusDotVariants = cva("inline-block shrink-0", {
  variants: {
    tone: {
      success: "",
      pending: "",
      danger: "",
      accent: "",
      info: "",
      // `--status-running`, not `--running`: the violet family must pass 3:1 on the dark sidebar
      // and on a selected row, which `--running` (#7c3aed) does not (#617).
      running: "",
      neutral: "",
    },
    shape: {
      filled: "size-[7px] rounded-full",
      ring: "size-[7px] rounded-full border-[1.5px] bg-transparent",
      // Explicit px: `size-3` follows `--spacing`, so density would shrink the 12px robot.
      workers: "inline-flex size-[12px] items-center justify-center",
    },
    pulse: {
      true: "animate-pulse motion-reduce:animate-none",
      false: "",
    },
  },
  compoundVariants: [
    { shape: "filled", tone: "success", className: "bg-success" },
    { shape: "filled", tone: "pending", className: "bg-pending-strong" },
    { shape: "filled", tone: "danger", className: "bg-danger" },
    { shape: "filled", tone: "accent", className: "bg-accent-strong" },
    { shape: "filled", tone: "info", className: "bg-info" },
    { shape: "filled", tone: "running", className: "bg-status-running" },
    { shape: "filled", tone: "neutral", className: "bg-soft-foreground" },
    { shape: "ring", tone: "success", className: "border-success" },
    { shape: "ring", tone: "pending", className: "border-pending-strong" },
    { shape: "ring", tone: "danger", className: "border-danger" },
    { shape: "ring", tone: "accent", className: "border-accent-strong" },
    { shape: "ring", tone: "info", className: "border-info" },
    { shape: "ring", tone: "running", className: "border-status-running" },
    { shape: "ring", tone: "neutral", className: "border-soft-foreground" },
    { shape: "workers", tone: "success", className: "text-success" },
    { shape: "workers", tone: "pending", className: "text-pending-strong" },
    { shape: "workers", tone: "danger", className: "text-danger" },
    { shape: "workers", tone: "accent", className: "text-accent-icon" },
    { shape: "workers", tone: "info", className: "text-info" },
    { shape: "workers", tone: "running", className: "text-status-running" },
    { shape: "workers", tone: "neutral", className: "text-soft-foreground" },
  ],
  defaultVariants: {
    tone: "neutral",
    shape: "filled",
    pulse: false,
  },
})

export type StatusDotTone = NonNullable<
  VariantProps<typeof statusDotVariants>["tone"]
>
export type StatusDotShape = NonNullable<
  VariantProps<typeof statusDotVariants>["shape"]
>

function StatusDot({
  className,
  tone = "neutral",
  shape = "filled",
  pulse = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusDotVariants>) {
  return (
    <span
      data-slot="status-dot"
      data-tone={tone}
      data-shape={shape}
      className={cn(statusDotVariants({ tone, shape, pulse, className }))}
      {...props}
    >
      {shape === "workers" ? <BotIcon className="size-[12px]" aria-hidden="true" /> : null}
    </span>
  )
}

export { StatusDot, statusDotVariants }
