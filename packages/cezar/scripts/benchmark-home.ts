import { Home } from '../src/home/home.ts';
import { readInstallMarker } from '../src/home/install-marker.ts';

/** Benchmarks may retain an explicit home, but must never use a live installation. */
export function benchmarkHome(home: Home): Home {
  if (readInstallMarker(home.root)?.kind === 'live') throw new Error('Benchmark refuses a live install marker');
  Home.sandbox(home.root);
  return home;
}
