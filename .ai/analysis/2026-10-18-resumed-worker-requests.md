# Resumed worker request reproduction

Subject: hearsay-tools/cezarion#1241. Baseline: `463a5bf016564778c7ae07057760e41caff79d7e`.

The issue was OPEN, unassigned, and had no linked open PR when checked on
2026-10-18. Its friction label identifies an agent report. No dependency was
needed to reproduce the behavior.

## Reproduction path

Use the real delegation service/store fixture in
`packages/cezar/src/delegation/conversation-service.test.ts`. It holds the
scheduler so the request deadline can be exercised without spending tokens.
Only Date is faked; no test sleeps for 45 minutes.

1. Complete a worker execution and send a new request with `resume: true` and
   `timeoutSeconds: 3600` (CLI equivalent: `worker send <worker-id> 'Fix review'
   --id <uuid> --kind request --resume --timeout-seconds 3600`). Baseline rejects
   this at `conversationSendRequestSchema` because its maximum is 1,800 seconds.
2. Send an accepted request with the default 600-second deadline. Advance Date
   by 45 minutes while keeping the worker running. Inspect conversation history:
   the outcome becomes `timed-out`.
3. Reply from the worker with the original request ID. Baseline accepts the reply
   envelope with `state: late`, but the conversation outcome remains `timed-out`
   with no reply ID. The same happens if inspection did not observe expiry first.

Squeal revision 1 observed all three new regression cases fail against unchanged
production source. Revision 3 additionally observed the upper-bound and transcript
amendment tests fail. At revision 7 the service cases recovered to PASS.

## Fix and boundaries

Resume requests can explicitly select 1–86,400 seconds (24 hours). The default
remains 600 seconds; ordinary requests and waits still cap at 1,800 seconds.
A request can still settle by explicit reply, cancellation, recipient lifecycle,
sender closure, destruction or deadline. A wait never extends its request.

The first reply after deadline expiry amends only `timed-out` to `replied-late`,
with reply ID and time. Later replies and exact retries preserve that result.
Cancellation and every other settlement remain final. The amendment has its own
idempotent transcript projection, and transcript replay accepts only this specific
transition. An already settled wait does not reopen.

The WP2 parity row exercises resumed requests and reply delivery through every
runner's native mock wire via HARNESS_ADAPTERS. With the original contract
restored, all six WP2 cells failed at the old 1,800-second cap; restoring the fix
made all six pass (`npm test -- packages/cezar/src/workflows/worker-wait-conversations.test.ts -t WP2`).
These manual runs satisfy the repository's explicit mutation-proof gate.
Typecheck and production build/check:pack passed. CI owns the complete suite gate.
