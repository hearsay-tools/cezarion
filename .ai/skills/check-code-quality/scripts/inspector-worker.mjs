import { startInspector } from './inspector-preload.mjs';

// Node has already decided whether to enable automatic process coverage before
// --import modules run. Activate only snapshot capture here; Vitest owns worker
// counters. Test-spawned children inherit the same directory for process coverage.
const raw = new URL(import.meta.url).searchParams.get('raw');
if (raw) {
  process.env.NODE_V8_COVERAGE = raw;
  startInspector();
}
