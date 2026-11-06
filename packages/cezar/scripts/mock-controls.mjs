// Load only when configured: ordinary mock turns retain their event-loop ordering.
export async function loadControls({ failure, delivery } = {}) {
  const failureControl = process.env.CEZ_MOCK_FAILURE_CONTROL === undefined ? undefined
    : (await import('./mock-failure-control.mjs')).readFailureControl(failure);
  const deliveryControl = process.env.CEZ_MOCK_DELIVERY_CONTROL === undefined ? undefined
    : (await import('./mock-delivery-control.mjs')).readDeliveryControl(delivery);
  return { failureControl, delivery: deliveryControl };
}
