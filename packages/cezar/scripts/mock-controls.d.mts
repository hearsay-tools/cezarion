import type { readFailureControl } from './mock-failure-control.mjs';
import type { readDeliveryControl } from './mock-delivery-control.mjs';

/** Loads the failure and delivery controls a test configured; appends this pid to `CEZ_MOCK_PID_FILE` when set. */
export declare function loadControls(options?: {
  failure?: Parameters<typeof readFailureControl>[0];
  delivery?: Parameters<typeof readDeliveryControl>[0];
}): Promise<{
  failureControl: ReturnType<typeof readFailureControl> | undefined;
  delivery: ReturnType<typeof readDeliveryControl> | undefined;
}>;
