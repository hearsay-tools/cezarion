import { describe, expect, it } from 'vitest'
import { reportTitle } from './report-title'

describe('reportTitle', () => {
  it('uses the title when present', () => {
    expect(reportTitle({ name: 'report.html', title: 'Results' })).toBe('Results')
  })
  it.each([['report.html', 'report'], ['REPORT.HTM', 'REPORT'], ['a.b.html', 'a.b'], ['report', 'report'], ['.report', '.report'], ['report.', 'report.']])('falls back from %s to %s', (name, expected) => {
    expect(reportTitle({ name })).toBe(expected)
  })
})
