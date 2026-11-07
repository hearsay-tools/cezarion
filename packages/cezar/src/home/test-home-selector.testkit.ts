import type { Home } from './home.ts';

let pinHome: ((home: Home | undefined) => void) | undefined;

/** Keep setup independent of the product modules that test files must mock. */
export function configureTestHomeSelector(pin: (home: Home | undefined) => void): void {
  pinHome = pin;
}

/** Only the shared setup writes the process environment. */
export function useTestHome(home: Home | undefined): void {
  if (!pinHome) throw new Error('The shared test setup has not installed its Home selector');
  pinHome(home);
}
