/** Build settings use defined-value precedence, including an intentional empty value. */
export function preferredBuildEnv(preferred: string | undefined, legacy: string | undefined): string | undefined {
  return preferred ?? legacy
}

export function e2eBuildEnabled(preferred: string | undefined, legacy: string | undefined): boolean {
  const value = preferredBuildEnv(preferred, legacy)
  return value === '1' || value === 'true'
}

/** A deployment meta tag wins over the API origin selected at build time. */
export function resolveBuildApiBase(meta: string | null | undefined, preferred: string | undefined, legacy: string | undefined): string {
  return meta?.trim() || preferredBuildEnv(preferred, legacy) || ''
}
