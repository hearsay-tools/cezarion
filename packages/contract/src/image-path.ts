const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** The image MIME type for a path, or null when it is not an image we serve raw. */
export function imageMimeType(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return IMAGE_MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Raster extensions allowed for OS default-app opening. Do not inherit SVG from the HTTP image
 * list: its browser response protections do not apply to an OS handoff.
 */
const OS_OPENABLE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

/** True when `path` is an image safe to hand to the OS's default handler — see OS_OPENABLE_EXT. */
export function isOsOpenableImage(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return OS_OPENABLE_EXT.has(name.slice(dot + 1).toLowerCase());
}


/** Images the browser can preview, including SVG under the raw route's protections. */
export function isImagePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return isOsOpenableImage(path) || (dot > 0 && name.slice(dot + 1).toLowerCase() === 'svg');
}
