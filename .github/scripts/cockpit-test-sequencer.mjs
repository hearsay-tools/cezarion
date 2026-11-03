import { hash } from 'node:crypto';
import { relative } from 'node:path';
import { readFileSync } from 'node:fs';
import CiTestSequencer from './ci-test-sequencer.mjs';

const manifest = JSON.parse(
  readFileSync(new URL('../cockpit-test-durations.json', import.meta.url), 'utf8'),
);

// Browser config.root is packages/web/e2e, so these keys are spec filenames.
// Keep duration-based shard membership. Opt-in shuffle also orders files by a
// seeded hash, independent of Vitest's previous-result cache and discovery order.
export default class CockpitTestSequencer extends CiTestSequencer {
  durations = manifest.durationsMs;

  async sort(specifications) {
    const { sequence } = this.ctx.config;
    if (!sequence.shuffle) return super.sort(specifications);
    return specifications.map(specification => ({
      specification,
      key: hash('sha256', `${sequence.seed}\0${relative(this.ctx.config.root, specification.moduleId)}`),
    })).sort((a, b) => a.key.localeCompare(b.key)).map(entry => entry.specification);
  }
}
