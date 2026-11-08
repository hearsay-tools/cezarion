# Chromium launch progress

Fixes hearsay-tools/cezarion#2674 and hearsay-tools/cezarion#2788.

The old per-attempt deadline guaranteed that an unresponsive Chromium could not
hold a preview launch forever. It also killed a cold launch that was still loading.
Replace elapsed-time failure with a 30-second silence window and an independent
120-second overall hang guard. The existing internal `timeoutMs` option now sets
the silence window; production uses the default. No user setting is added.

Progress means nonempty stderr or inbound DevTools bytes. On Linux it also means
changed minor/major page-fault or CPU-time counters in `/proc/<pid>/stat`, sampled
once per second when no other progress was just observed. Process existence alone
is not progress. Missing procfs contributes no progress and does not fail launch.
The initial counter read supplies a baseline, not an activity signal.

| Case | Result |
| --- | --- |
| Silent cold load with changing CPU or fault counters beyond 30 seconds | Keep the first process; accept its ready reply |
| Periodic stderr or partial DevTools replies beyond 30 seconds | Reset silence; accept the complete ready reply |
| Alive with unchanged counters and no bytes for 30 seconds | Kill, reap within the existing bound, retry once |
| Second silence stall | Kill and report the silence window and both attempts |
| Progress continues without readiness for 120 seconds | Kill and report the hang guard; do not retry |
| Process exits or pipe closes before readiness | Preserve exit diagnostics and fail without retry |
| Ready reply arrives | Clear launch timers and remove progress listeners |
| procfs absent, denied or malformed | Use stderr and DevTools progress only |

The PID record, profile, process cleanup, sandbox policy and ready signal remain
unchanged. Existing timeout assertions retain their bounds; the diagnostic now
names silence rather than elapsed launch time. Real-Chrome callers continue to
use `launchChromium` through the same browser launcher.
