// The exports TypeScript imports from resolve-browser-launch.mjs.
export declare const CHROME_SINGLETON_OVERHEAD: number
export declare const UNIX_SOCKET_MAX: number
export declare const DARWIN_UNIX_SOCKET_MAX: number

export declare function tmpdirExceedsSocketBudget(
  env?: Record<string, string | undefined>,
  platform?: NodeJS.Platform,
  unixSocketMax?: number,
): boolean
