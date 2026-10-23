# Guard local HTTP and WebSocket authority

A loopback bind alone does not stop a browser from sending requests that start shell-capable
agents. Local API requests therefore require a recognized loopback Host. Browser writes also
check the full Origin authority, including port, with a narrowly recognized development proxy
case. Health remains CORS-readable for discovery, but still passes the Host check.

## Consequences

Hosted mode does not apply the loopback Host allowlist; deployment authentication and the
same-authority write guard remain separate responsibilities. Missing Origin admits native clients,
so these checks do not authenticate arbitrary local processes.

WebSockets need an explicit upgrade guard because CORS does not protect their responses.
A metadata-free foreign loopback page can receive an untrusted verdict for compatibility;
only publishers marked loopback-readable are available to it. Task content stays trusted-only.
Preview upgrades require trust rather than inheriting the health exception.

## Considered Options

- **Rely on loopback binding or CORS alone.** Rejected because writes and WebSocket reads have different browser protections.
- **Trust every admitted loopback WebSocket.** Rejected; compatibility admission and content trust are separate verdicts.

Implementation: [server.ts](../../packages/cezar/src/server/server.ts), [ws.ts](../../packages/cezar/src/server/ws.ts), [preview-socket.ts](../../packages/cezar/src/server/preview-socket.ts).

Coverage: [origin-guard.test.ts](../../packages/cezar/src/server/origin-guard.test.ts), [ws.test.ts](../../packages/cezar/src/server/ws.test.ts).
