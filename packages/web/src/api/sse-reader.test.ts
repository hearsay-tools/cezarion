import { describe, expect, it } from 'vitest'
import { readSse } from './sse-reader'

const response = (...chunks: string[]) => new Response(new ReadableStream({ start(controller) {
  for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
  controller.close()
} }))
describe('incremental SSE decoding', () => {
  it('preserves CRLF split across chunks and multiline data', async () => {
    const frames: unknown[] = []
    await readSse(response(':comment\r', '\nevent: run-event\r\ndata: first\r\n', 'data: second\r\n\r', '\nid: 2\ndata: last\n\n'), frame => { frames.push(frame) }, new AbortController().signal)
    expect(frames).toEqual([{ event: 'run-event', data: 'first\nsecond', id: '' }, { event: 'message', data: 'last', id: '2' }])
  })
  it('keeps UTF-8 characters split at a byte boundary', async () => {
    const bytes = new TextEncoder().encode('data: 雪\n\n')
    const input = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } }))
    const frames: string[] = []
    await readSse(input, frame => { frames.push(frame.data) }, new AbortController().signal)
    expect(frames).toEqual(['雪'])
  })
  it('rejects oversized or unsuccessful streams and cancels the reader', async () => {
    await expect(readSse(response('data: ' + 'x'.repeat(1024 * 1024 + 1)), () => {}, new AbortController().signal)).rejects.toThrow('limit')
    await expect(readSse(new Response('', { status: 401 }), () => {}, new AbortController().signal)).rejects.toThrow('401')
  })
})


it.each([-1, 0, 1])('bounds UTF-8 SSE wire bytes at the exact frame cap (%i)', async offset => {
  const limit = 1024 * 1024
  const prefix = 'event: live\ndata: '
  const suffix = '\n\n'
  const content = '雪' + 'x'.repeat(limit + offset - new TextEncoder().encode(prefix + '雪' + suffix).length)
  const frames: string[] = []
  const reading = readSse(response(prefix + content + suffix), frame => frames.push(frame.data), new AbortController().signal)
  if (offset > 0) {
    await expect(reading).rejects.toThrow('limit')
    expect(frames).toHaveLength(0)
  } else {
    await reading
    expect(frames).toEqual([content])
  }
})
