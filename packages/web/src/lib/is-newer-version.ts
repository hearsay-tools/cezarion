/** Mirrors the server's release-only numeric comparison. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => value.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}
