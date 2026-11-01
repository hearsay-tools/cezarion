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
  it.each([
    ['guide.md#install', 'guide.md', '#install'],
    ['notes%23draft.md#details', 'notes#draft.md', '#details'],
    ['file:///tmp/guide.md#install', 'file:///tmp/guide.md', '#install'],
  ])('keeps the fragment separate from the file selector for %s', (href, path, hash) => {
    const target = new URL(taskFileHref(href, context)!, 'https://cockpit.test')
    expect(target.searchParams.get('path')).toBe(path)
    expect(target.hash).toBe(hash)
  })
  it('preserves fragments when sending a published artifact link to the reader', () => {
    const id = '4c15e25b-a08c-438d-a32b-fd1a8c6c90e2'
    expect(taskFileHref(`/tasks/task/files?artifact=${id}#install`, context)).toBe(`/p/project/tasks/task/report?artifact=${id}#install`)
  })
  it('sends a generated artifact link to the reader without treating it as a file', () => {
    const id = '4c15e25b-a08c-438d-a32b-fd1a8c6c90e2'
    expect(taskFileHref(`/tasks/task/files?artifact=${id}`, context)).toBe(`/p/project/tasks/task/report?artifact=${id}`)
  })
  it('keeps unscoped legacy artifact links usable and does not reassign another task', () => {
    const href = '/tasks/task/files?artifact=4c15e25b-a08c-438d-a32b-fd1a8c6c90e2'
    expect(taskFileHref(href, { runId: 'task' })).toBe('/tasks/task/report?artifact=4c15e25b-a08c-438d-a32b-fd1a8c6c90e2')
    expect(taskFileHref(href, { runId: 'another', projectId: 'other' })).toBeNull()
  })
  it.each([
    ['owner', 'owner-task', { runId: 'owner-task', projectId: 'owner' }],
    ['owner', 'owner-task', { runId: 'boot-task', projectId: 'boot' }],
  ])('opens a project-scoped publication of %s/%s in its owner\'s reader from any thread', (project, run, ctx) => {
    const id = '4c15e25b-a08c-438d-a32b-fd1a8c6c90e2'
    expect(taskFileHref(`/p/${project}/tasks/${run}/files?artifact=${id}`, ctx)).toBe(`/p/${project}/tasks/${run}/report?artifact=${id}`)
  })
  it.each([
    '/p/owner/tasks/run/files?artifact=not-a-uuid',
    '/p/owner/tasks/run/files?artifact=4c15e25b-a08c-438d-a32b-fd1a8c6c90e2&path=x',
    '/p/owner/tasks/run/changes?artifact=4c15e25b-a08c-438d-a32b-fd1a8c6c90e2',
    '/p/owner/tasks/run/files?path=report.html',
  ])('keeps other author-written cockpit URLs behind the confirmation: %s', href => {
    expect(taskFileHref(href, context)).toBeNull()
  })
  it.each(['docs/report.html', '/tmp/REPORT.HTM', 'file:///tmp/r.html'])('opens the HTML path %s in the reader', path => {
    expect(taskFileHref(path, context)).toBe(`/p/project/tasks/task/report?path=${encodeURIComponent(path)}`)
  })
  it('resolves document relative links against its directory', () => {
    expect(taskFileHref('next.md', { ...context, basePath: '/repo/docs/ADR.md' })).toBe('/p/project/tasks/task/files?path=%2Frepo%2Fdocs%2Fnext.md')
  })
})
