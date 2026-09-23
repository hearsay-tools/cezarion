import { describe, expect, it } from 'vitest'
import { taskFileHref } from './file-links'

const context = { runId: 'task', projectId: 'project' }
describe('task file links', () => {
  it.each(['docs/ADR.md', './a.txt', '../report.md', '/Users/me/a.md', 'file:///tmp/a%20b.md', 'C:\\Users\\me\\a.md'])('routes %s without decoding the path twice', path => {
    expect(taskFileHref(path, context)).toBe(`/p/project/tasks/task/files?path=${encodeURIComponent(path)}`)
  })
  it.each(['https://example.com/doc', 'http://example.com', '//example.com/path', '#heading', 'mailto:a@example.com', 'javascript:void(0)', 'data:text/html,bad', '/api/v1/health', '/p/other/tasks/x', '/tasks/another', '/tmp/%zz'])('does not reinterpret %s', href => {
    expect(taskFileHref(href, context)).toBeNull()
  })
  it('decodes Markdown URI encoding once, before encoding the raw path query', () => {
    expect(taskFileHref('docs/a%20b.md', context)).toBe('/p/project/tasks/task/files?path=docs%2Fa%20b.md')
    expect(taskFileHref('docs/literal%2520.md', context)).toBe('/p/project/tasks/task/files?path=docs%2Fliteral%2520.md')
  })
  it('scopes a generated artifact link without treating it as a file', () => {
    const id = '4c15e25b-a08c-438d-a32b-fd1a8c6c90e2'
    expect(taskFileHref(`/tasks/task/files?artifact=${id}`, context)).toBe(`/p/project/tasks/task/files?artifact=${id}`)
  })
  it('resolves document relative links against its directory', () => {
    expect(taskFileHref('next.md', { ...context, basePath: '/repo/docs/ADR.md' })).toBe('/p/project/tasks/task/files?path=%2Frepo%2Fdocs%2Fnext.md')
  })
})
