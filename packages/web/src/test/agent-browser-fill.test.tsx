import { cleanup, render } from '@testing-library/react'
import { createElement, useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentBrowser } from '../../e2e/agent-browser'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['input', 'textarea'] as const)('replaces a controlled %s when palette results render between clear and insert', tag => {
  let refresh = () => {}
  let state = ''
  function Palette() {
    const [value, setValue] = useState('Waiting root fixture')
    const [results, setResults] = useState(0)
    state = value
    refresh = () => setResults(count => count + 1)
    return createElement(tag, {
      id: 'search', value, 'data-results': results,
      onChange: (event: { target: { value: string } }) => setValue(event.target.value),
    })
  }
  render(createElement(Palette))
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('#search')!
  const prototype = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const nativeSet = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  const browser = AgentBrowser.attach({ installed: true, command: 'unused', version: 'fixture', notes: '' }, 'fill-test')
  // Run the seam's page expressions against real React. Only the provider transport is fake.
  const transport = browser as unknown as { run(args: string[]): Record<string, unknown> }
  vi.spyOn(transport, 'run').mockImplementation(([command, expression, value]) => {
    if (command === 'eval') return { result: window.eval(expression!) }
    if (command === 'fill') {
      // agent-browser 0.39.4 clears through React's own value tracker, then inserts over CDP.
      field.select()
      field.value = ''
      field.dispatchEvent(new Event('input', { bubbles: true }))
      flushSync(refresh)
      nativeSet.call(field, field.value + value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return {}
  })
  browser.fill('#search', 'Owned worker 1')
  expect(field.value).toBe('Owned worker 1')
  expect(state).toBe('Owned worker 1')
})
