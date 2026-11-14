import { Home, kindHomePaths } from './home.ts';
import { nativePathPlatform, oneRootKinds } from './kind-roots.ts';
export { configureTestHomeSelector, useTestHome } from './test-home-selector.testkit.ts';

/** Widely used test constructors share the selected sandbox rather than resolving a product Home. */
export function testHome(env: NodeJS.ProcessEnv = process.env): Home {
  const root = env.CEZ_HOME || process.env.CEZ_HOME;
  if (!root) throw new Error('Test Home requires a sandbox CEZ_HOME; run with the shared test setup.');
  // The selector already prepared this home. Readers with filesystem mocks need no bootstrap.
  if (root !== process.env.CEZ_HOME) return Home.sandbox(root);
  return kindHomePaths(oneRootKinds(root, nativePathPlatform), 'split', nativePathPlatform, root);
}
