"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { keyboardAwareCollisionPadding, useViewportInsets } from "@/lib/keyboard-inset"
import { cn } from "@/lib/utils"

const TouchOpenContext = React.createContext<React.RefObject<boolean> | null>(null)

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const openedWithTouch = React.useRef(false)
  return (
    <TouchOpenContext value={openedWithTouch}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </TouchOpenContext>
  )
}

function PopoverTrigger({
  onPointerDownCapture,
  onKeyDownCapture,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const openedWithTouch = React.useContext(TouchOpenContext)
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...props}
      onPointerDownCapture={(event) => {
        if (openedWithTouch) openedWithTouch.current = event.pointerType === "touch"
        onPointerDownCapture?.(event)
      }}
      onKeyDownCapture={(event) => {
        if (openedWithTouch) openedWithTouch.current = false
        onKeyDownCapture?.(event)
      }}
    />
  )
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding,
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // Collision avoidance against the viewport the user can SEE: the mobile virtual keyboard
  // shrinks only the visual viewport (iOS never resizes the layout one — see keyboard-inset),
  // so without these insets a popover near the composer positions itself under the keys.
  // Insets change re-render the content, which re-runs Radix's positioning. Desktop engines
  // report {0,0} and keep the exact previous behavior.
  const insets = useViewportInsets()
  const openedWithTouch = React.useContext(TouchOpenContext)
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        onOpenAutoFocus={(event) => {
          const touch = openedWithTouch?.current
          if (openedWithTouch) openedWithTouch.current = false
          onOpenAutoFocus?.(event)
          if (event.defaultPrevented || !touch) return
          const content = event.target
          if (content instanceof HTMLElement && content.querySelector("[cmdk-input]")) {
            // Browse a searchable dropdown before typing on touch. Focus the container
            // so a previously focused composer also releases its software keyboard.
            event.preventDefault()
            content.focus({ preventScroll: true })
          }
        }}
        collisionPadding={keyboardAwareCollisionPadding(insets, collisionPadding)}
        className={cn(
          "z-50 w-72 max-w-(--radix-popover-content-available-width) [overflow-wrap:anywhere] origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
}
