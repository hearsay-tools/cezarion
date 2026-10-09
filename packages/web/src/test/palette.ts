/** Convert token literals back to their original 8-bit sRGB values for palette regression
 * assertions. Production remains OKLCH; the expected approved palette stays independent. */
export function paletteHex(value: string): string {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+|none)(?: \/ ([\d.]+))?\)$/.exec(value)
  if (!match) return value
  const L = Number(match[1]), C = Number(match[2]), hue = match[3] === 'none' ? 0 : Number(match[3]) * Math.PI / 180
  const a = C * Math.cos(hue), b = C * Math.sin(hue)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const channels = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  const byte = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0')
  return '#' + channels.map(n => byte(n <= 0.0031308 ? 12.92 * n : 1.055 * n ** (1 / 2.4) - 0.055)).join('') +
    (match[4] === undefined ? '' : byte(Number(match[4])))
}
