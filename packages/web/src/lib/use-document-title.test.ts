import { productName } from '@/lib/product-name'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  documentTitleOf,
  type DocumentTitleParts,
  useDocumentTitle,
} from './use-document-title'

describe('documentTitleOf', () => {
  it.each([
    {
      name: 'project and page',
      projectName: 'Storefront',
      pageLabel: 'Tasks',
      expected: `Storefront — Tasks · ${productName("cezar")}`,
    },
    {
      name: 'project only',
      projectName: 'Storefront',
      pageLabel: null,
      expected: `Storefront · ${productName("cezar")}`,
    },
    {
      name: 'page only',
      projectName: null,
      pageLabel: 'Settings',
      expected: `Settings · ${productName("cezar")}`,
    },
    { name: 'neither part', projectName: null, pageLabel: null, expected: `${productName("cezar")}` },
    { name: 'empty project', projectName: '', pageLabel: 'Tasks', expected: `Tasks · ${productName("cezar")}` },
    { name: 'blank parts', projectName: '  ', pageLabel: '\t', expected: `${productName("cezar")}` },
  ])('formats $name', ({ projectName, pageLabel, expected }) => {
    expect(documentTitleOf({ projectName, pageLabel })).toBe(expected)
  })
})

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = `${productName("cezar")}`
  })

  it('updates the existing writer when its truthful inputs change', () => {
    const initialProps: DocumentTitleParts = {
      projectName: 'Storefront',
      pageLabel: 'Tasks',
    }
    const { rerender } = renderHook(
      (parts: DocumentTitleParts) => useDocumentTitle(parts),
      { initialProps },
    )

    expect(document.title).toBe(`Storefront — Tasks · ${productName("cezar")}`)
    rerender({ projectName: 'Back office', pageLabel: null })
    expect(document.title).toBe(`Back office · ${productName("cezar")}`)
  })
})
