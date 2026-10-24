import unitConfig from '../../vitest.config.ts';
import NodeFloorTestSequencer from './node-floor-test-sequencer.mjs';

// Vitest expects a constructor here; its CLI does not import a sequencer path.
export default {
  ...unitConfig,
  test: {
    ...unitConfig.test,
    sequence: { ...unitConfig.test.sequence, sequencer: NodeFloorTestSequencer },
  },
};
