import { Home } from './home.ts';

let pinHome: ((home: Home | undefined) => void) | undefined;

/** The shared Vitest setup owns the environment bridge used by real CLI entry tests. */
export function configureTestHomeSelector(pin: (home: Home | undefined) => void): void {
  pinHome = pin;
}

/** Select an explicit fixture Home. Only the shared setup writes the process environment. */
export function useTestHome(home: Home | undefined): void {
  if (!pinHome) throw new Error('The shared test setup has not installed its Home selector');
  pinHome(home);
}

/** Widely used test constructors share the selected sandbox rather than resolving a product Home. */
export function testHome(env: NodeJS.ProcessEnv = process.env): Home {
  const root = env.CEZ_HOME || process.env.CEZ_HOME;
  if (!root) throw new Error('Test Home requires a sandbox CEZ_HOME; run with the shared test setup.');
  return Home.sandbox(root);
}
