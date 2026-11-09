import { appendFileSync } from 'node:fs';

// Load only when configured: ordinary mock turns retain their event-loop ordering.
// Every native mock calls this once at startup, so `CEZ_MOCK_PID_FILE` lists every native process a
// session started, one pid per line (seam contract row S43).
export async function loadControls({ failure, delivery } = {}) {
  if (process.env.CEZ_MOCK_PID_FILE) appendFileSync(process.env.CEZ_MOCK_PID_FILE, `${process.pid}\n`);
  const failureControl = process.env.CEZ_MOCK_FAILURE_CONTROL === undefined ? undefined
    : (await import('./mock-failure-control.mjs')).readFailureControl(failure);
  const deliveryControl = process.env.CEZ_MOCK_DELIVERY_CONTROL === undefined ? undefined
    : (await import('./mock-delivery-control.mjs')).readDeliveryControl(delivery);
  return { failureControl, delivery: deliveryControl };
}
