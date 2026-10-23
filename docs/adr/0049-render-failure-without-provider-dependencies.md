# Render application failure without provider dependencies

An uncaught render failure can otherwise leave an empty cockpit that looks like an endless
load. A root error boundary renders a self-contained failure surface without depending on
application providers or design-system components, since one of those may be the failing input.

## Consequences

Keep a stable `app-error` marker and accessible alert so people and verification can identify
a render crash. Preserve error details and console evidence and offer reload. The marker’s
absence is not proof that the application is healthy; it only means this boundary has not
rendered its failure state. No historical production crash is asserted by this decision.

Implementation: [app-error-boundary.tsx](../../packages/web/src/components/app-error-boundary.tsx), [app.tsx](../../packages/web/src/app.tsx).

Coverage: [app-error-boundary.test.tsx](../../packages/web/src/components/app-error-boundary.test.tsx).
