import { readFileSync } from 'node:fs';
import CiTestSequencer from './ci-test-sequencer.mjs';

const manifest = JSON.parse(
  readFileSync(new URL('../cockpit-test-durations.json', import.meta.url), 'utf8'),
);

// Browser config.root is packages/web/e2e, so these keys are spec filenames.
// Inherit the same allocator and Vitest sort as the unit suites; the manifest
// supplies weights only. Test discovery remains entirely Vitest's responsibility.
export default class CockpitTestSequencer extends CiTestSequencer {
  durations = manifest.durationsMs;
}
