import type { PreviewQuality } from '@open-mercato/cezar-api-client'

/*
 * The preview's stream quality (hearsay-tools/cezarion#2066): the pure half. The choice belongs to
 * the browser you sit at, like the split width beside it, so it lives in localStorage. No config
 * key, no `CEZ_*` flag.
 */

/** Namespaced `cez-` like `cez-sidebar-width`. Anything but `high` or `ultra`, an absent key included, is Normal. */
export const PREVIEW_QUALITY_STORAGE_KEY = 'cez-preview-quality'

export const PREVIEW_QUALITIES: ReadonlyArray<{ value: PreviewQuality; label: string; detail: string }> = [
  { value: 'normal', label: 'Normal', detail: 'The default. Lighter on CPU and network.' },
  // Quality 100 is still lossy JPEG: never call it lossless.
  { value: 'high', label: 'High', detail: 'Sharper text and fine detail. Uses more CPU and network.' },
  // hearsay-tools/cezarion#2069: the page renders at the viewer's devicePixelRatio, capped at 2.
  { value: 'ultra', label: 'Ultra', detail: "High at your screen's pixel density, up to 2×. Uses the most CPU and network." },
]

/** A stored or chosen value as a mode: anything that is not a mode is Normal. */
export function toPreviewQuality(value: unknown): PreviewQuality {
  return PREVIEW_QUALITIES.find(option => option.value === value)?.value ?? 'normal'
}

export const qualityLabel = (quality: PreviewQuality): string => PREVIEW_QUALITIES.find(option => option.value === quality)?.label ?? 'Normal'

/** The stored choice, or Normal when storage is empty, unreadable (private mode) or junk. */
export function readStoredPreviewQuality(): PreviewQuality {
  try {
    return toPreviewQuality(localStorage.getItem(PREVIEW_QUALITY_STORAGE_KEY))
  } catch {
    return 'normal'
  }
}

export function writeStoredPreviewQuality(quality: PreviewQuality): void {
  try {
    localStorage.setItem(PREVIEW_QUALITY_STORAGE_KEY, quality)
  } catch {
    // Private mode / storage disabled: the choice still applies for this pane.
  }
}
