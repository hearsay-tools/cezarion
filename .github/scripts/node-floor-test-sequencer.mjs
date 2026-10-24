import { readFileSync } from 'node:fs';
import CiTestSequencer from './ci-test-sequencer.mjs';

const measurements = JSON.parse(readFileSync(new URL('../node-floor-test-durations.json', import.meta.url), 'utf8'));

export default class NodeFloorTestSequencer extends CiTestSequencer {
  durations = measurements.durationsMs;

  get shardCosts() {
    const { maxWorkers, shard } = this.ctx.config;
    if (!Number.isInteger(maxWorkers) || maxWorkers <= 0) {
      throw new TypeError('floor balancing requires a positive integer maxWorkers');
    }
    // File weights are concurrent module wall times. Reserve equivalent worker
    // time for shard 1's sequential typecheck and Node suites before assigning files.
    return Array.from({ length: shard.count }, (_, index) => index === 0
      ? measurements.fixedWorkMs * maxWorkers : 0);
  }
}
