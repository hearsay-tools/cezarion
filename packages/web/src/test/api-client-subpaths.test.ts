import { afterEach, describe, expect, it } from 'vitest'
import * as root from '@open-mercato/cezar-api-client'
import * as runLabels from '@open-mercato/cezar-api-client/contract/run-labels'
import * as workspace from '@open-mercato/cezar-api-client/contract/workspace'
import * as scope from '@open-mercato/cezar-api-client/utils/project-scope'

/**
 * The cockpit resolves the api-client root through an alias and its subpaths through the
 * package's `exports` (hearsay-tools/cezarion#1237). Both must land on the same files: two copies
 * of `utils/project-scope.ts` would hold two API scopes, and a scope set through one would read
 * stale through the other.
 */
describe('api-client subpaths under the cockpit resolver', () => {
  const initialScope = scope.getApiScope()
  afterEach(() => scope.setApiScope(initialScope))

  it('binds the same functions through the root and through a subpath', () => {
    expect(root.setApiScope).toBe(scope.setApiScope)
    expect(root.getApiScope).toBe(scope.getApiScope)
    expect(root.normalizeSidebarLimits).toBe(workspace.normalizeSidebarLimits)
    expect(root.runWorkflowLabel).toBe(runLabels.runWorkflowLabel)
  })

  it('shares one API scope between the root and the subpath', () => {
    scope.setApiScope('shop')
    expect(root.getApiScope()).toBe('shop')
  })
})
