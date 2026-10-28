import type { PreviewQuality } from '@open-mercato/cezar-api-client'

/*
 * The preview's stream quality (hearsay-tools/cezarion#2066): the pure half. The choice belongs to
 * the browser you sit at, like the split width beside it, so it lives in localStorage. No config
 * key, no `CEZ_*` flag.
 */

/** Namespaced `cez-` like `cez-sidebar-width`. Anything but `high`, an absent key included, is Normal. */
export const PREVIEW_QUALITY_STORAGE_KEY = 'cez-preview-quality'

export const PREVIEW_QUALITIES: ReadonlyArray<{ value: PreviewQuality; label: string; detail: string }> = [
  { value: 'normal', label: 'Normal', detail: 'The default. Lighter on CPU and network.' },
  // Quality 100 is still lossy JPEG: never call it lossless.
  { value: 'high', label: 'High', detail: 'Sharper text and fine detail. Uses more CPU and network.' },
]

export const qualityLabel = (quality: PreviewQuality): string => (quality === 'high' ? 'High' : 'Normal')

/** The stored choice, or Normal when storage is empty, unreadable (private mode) or junk. */
export function readStoredPreviewQuality(): PreviewQuality {
  try {
    return localStorage.getItem(PREVIEW_QUALITY_STORAGE_KEY) === 'high' ? 'high' : 'normal'
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
