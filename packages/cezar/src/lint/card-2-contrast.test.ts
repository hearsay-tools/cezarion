// @vitest-environment node
import { expect, it } from 'vitest'
import { scan as scanContrast } from './card-2-contrast.ts'

// Explicit fixture palette: no repository reads belong to these scanner cases.
const surfaces = new Set(['bg-card-2', 'bg-background', 'bg-black', 'bg-white'])
const scan = (source: string): string[] => scanContrast(source, surfaces)

it('catches unsafe small text on the element, descendants, conditional classes and known body slots', () => {
  expect(scan(`<><p className="bg-card-2 text-danger text-xs">bad</p><div className="bg-card-2"><span className={cn('text-xs', bad ? 'text-danger' : 'text-muted-foreground')}>bad</span></div><div data-slot="tool-error" className="text-soft-foreground">bad</div></>`)).toHaveLength(3)
})
it('follows inherited ink and size through expressions and fragments', () => {
  expect(scan(`<div className="bg-card-2 text-danger text-[11px]">{ok === true && <><span>bad</span></>}</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-[24px]"><span className="text-xs">bad</span></div>`)).toHaveLength(1)
})
it('accepts safe ink, separate surfaces, large text, icons and unrelated text', () => {
  expect(scan(`<><div className="bg-card-2"><p className="text-muted-foreground text-xs">ok</p><svg className="text-danger"/><p className="text-danger text-[24px]">large</p><p className="bg-background text-danger">other</p></div><p className="text-danger">elsewhere</p></>`)).toEqual([])
})
it('checks every possible size and background branch conservatively', () => {
  expect(scan(`<p className={cn('bg-card-2 text-danger', ok ? 'text-2xl' : 'text-xs')}>bad</p>`)).toHaveLength(1)
  expect(scan(`<p className={cn('text-xs text-danger', ok ? 'bg-background' : 'bg-card-2')}>bad</p>`)).toHaveLength(1)
})
it('retains card-2 underneath transparent backgrounds', () => {
  expect(scan(`<div className="bg-card-2"><p className="bg-transparent text-xs text-danger">bad</p></div>`)).toHaveLength(1)
})
it('keeps card-2 through background layout and image utilities', () => {
  for (const utility of ['bg-cover', 'bg-center', 'bg-no-repeat', 'bg-fixed', 'bg-clip-text', 'bg-[url(/image.png)]']) {
    expect(scan(`<div className="bg-card-2"><p className="${utility} text-xs text-danger">bad</p></div>`), utility).toHaveLength(1)
  }
})
it('treats explicit unknown font sizes as small instead of inheriting large text', () => {
  for (const size of ['text-[length:var(--small)]', 'text-(length:--small)', 'text-[0.75rem]', 'text-[12px]/4']) {
    expect(scan(`<div className="bg-card-2 text-danger text-[24px]"><span className="${size}">bad</span></div>`), size).toHaveLength(1)
  }
  expect(scan(`<div className="bg-card-2 text-danger text-[24px]"><span className="text-center text-muted-foreground">safe</span></div>`)).toEqual([])
})
it('checks variant colors, sizes and surfaces without losing inherited defaults', () => {
  expect(scan(`<div className="bg-card-2 text-foreground text-[24px]"><span className="md:text-danger md:text-xs">bad</span></div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xs"><span className="md:text-foreground md:text-2xl md:bg-background">bad by default</span></div>`)).toHaveLength(1)
  expect(scan(`<p className="bg-background text-danger text-xs md:bg-card-2">bad</p>`)).toHaveLength(1)
  expect(scan(`<p className="bg-card-2 text-foreground text-[24px] [&:hover]:text-danger [&:hover]:text-[length:var(--small)]">bad</p>`)).toHaveLength(1)
  expect(scan(`<p className="bg-card-2 text-muted-foreground md:text-foreground text-xs md:text-2xl">safe</p>`)).toEqual([])
})
it('applies the bold large-text threshold and follows inherited size and weight', () => {
  expect(scan(`<div className="bg-card-2 text-danger text-xl font-bold">safe</div>`)).toEqual([])
  expect(scan(`<div className="bg-card-2 text-danger text-[20px]"><span className="font-bold">safe</span></div>`)).toEqual([])
  expect(scan(`<div className="bg-card-2 text-danger text-[19px] font-bold"><span>safe</span></div>`)).toEqual([])
  expect(scan(`<div className="bg-card-2 text-danger text-[18px] font-bold">small</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xl font-bold"><span className="font-normal">small</span></div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xl font-bold md:font-normal">small at md</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xl font-semibold">small</div>`)).toHaveLength(1)
})
it('treats destructive as the unsafe danger palette alias', () => {
  expect(scan(`<p className="bg-card-2 text-xs text-destructive">bad</p>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-destructive text-xs"><span>bad</span></div>`)).toHaveLength(1)
  expect(scan(`<p className="bg-card-2 text-xs text-foreground hover:text-destructive">bad on hover</p>`)).toHaveLength(1)
  expect(scan(`<p className="bg-card-2 text-destructive text-[24px]">large</p>`)).toEqual([])
})
it('recognizes important utility modifiers', () => {
  expect(scan(`<p className="bg-card-2! text-xs! text-danger!">bad</p>`)).toHaveLength(1)
  expect(scan(`<p className="!bg-card-2 !text-xs !text-destructive">bad</p>`)).toHaveLength(1)
  expect(scan(`<p className="bg-card-2 text-xs md:text-destructive!">bad</p>`)).toHaveLength(1)
})
it('retains unsafe ink through opacity modifiers', () => {
  for (const color of ['text-danger/80', 'text-soft-foreground/70', 'text-destructive/[0.8]', 'md:text-danger/80!']) {
    expect(scan(`<p className="bg-card-2 text-xs ${color}">bad</p>`), color).toHaveLength(1)
  }
  expect(scan(`<div className="bg-card-2 text-danger/80 text-xs"><span>bad</span></div>`)).toHaveLength(1)
})
it('recognizes fully opaque card-2 background modifiers', () => {
  for (const background of ['bg-card-2/100', 'bg-card-2/[1]', 'bg-card-2/[100%]', 'md:bg-card-2/100!']) {
    expect(scan(`<p className="${background} text-danger text-xs">bad</p>`), background).toHaveLength(1)
  }
  expect(scan(`<div className="bg-card-2"><p className="bg-background/100 text-danger text-xs">separate</p></div>`)).toEqual([])
})
it('lets documented safe foregrounds override inherited unsafe ink', () => {
  expect(scan(`<div className="bg-card-2 text-danger"><span className="text-supporting-foreground">safe</span><span className="text-link-foreground">safe</span></div>`)).toEqual([])
})
it('does not count safely styled JSX branches as text in their wrapper', () => {
  expect(scan(`<div className="bg-card-2 text-danger">{ok === true && <span className="text-muted-foreground">safe</span>}{ok ? <span className="text-foreground">safe</span> : null}</div>`)).toEqual([])
  expect(scan(`<div className="bg-card-2 text-danger">{ok ? <span className="text-foreground">safe</span> : 'bad'}</div>`)).toHaveLength(1)
})
it('checks raw text in fragments without counting safely styled elements twice', () => {
  expect(scan(`<div className="bg-card-2 text-danger text-xs"><>visible text</></div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{ok && <>visible text</>}</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xs"><><><span className="text-muted-foreground">safe</span></></></div>`)).toEqual([])
})
it('does not count boolean-result expressions as wrapper text', () => {
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{count > 0 || <span className="text-muted-foreground">safe</span>}</div>`)).toEqual([])
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{count > 0 ?? <span className="text-muted-foreground">safe</span>}</div>`)).toEqual([])
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{!!count}{typeof count === 'number'}{delete obj.key}</div>`)).toEqual([])
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{count + 1 || <span className="text-muted-foreground">safe</span>}</div>`)).toHaveLength(1)
})
it('checks numeric falsy text rendered by logical guards', () => {
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{0 && <span className="text-muted-foreground">safe</span>}</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{count && <span className="text-muted-foreground">safe</span>}</div>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2 text-danger text-xs">{count > 0 && <span className="text-muted-foreground">safe</span>}{!!count && <span className="text-foreground">safe</span>}</div>`)).toEqual([])
})
it('retains inherited defaults in absent class branches', () => {
  expect(scan(`<p className={cn('bg-card-2 text-danger', big ? 'text-2xl' : '')}>bad</p>`)).toHaveLength(1)
  expect(scan(`<div className="bg-card-2"><p className={cn('text-danger text-xs', other ? 'bg-background' : '')}>bad</p></div>`)).toHaveLength(1)
  expect(scan(`<p className={cn('bg-card-2 text-danger', big && 'text-2xl')}>bad</p>`)).toHaveLength(1)
})
it('reads literal helper arrays, object keys, templates and type wrappers', () => {
  expect(scan(`<p className={cn(...(['bg-card-2', 'text-danger', 'text-xs'] as const))}>bad</p>`)).toHaveLength(1)
  expect(scan(`<p className={cn('bg-card-2 text-xs', {'text-danger': bad})}>bad</p>`)).toHaveLength(1)
  expect(scan('<p className={`bg-card-2 text-danger text-${big ? "2xl" : "xs"}`}>bad</p>')).toHaveLength(1)
})
