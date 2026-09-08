# Further shard balancing and Blacksmith comparison

User authorized overnight work after PR158 completes: improve shard balance if possible; test the exact Blacksmith job migrations in PR154; retain Blacksmith only if CI wall clock improves.

Baseline: verified PR158 head252b749d464a8f630f7446a6ff29e6f8fa076b10. Keep PR158 draft and unchanged. Use a separate follow-up branch, stacking a proven result if main has not yet received PR158.

Measure actual ci.yml workflow_dispatch executions on matched refs, changing only build-and-package and Vitest runs-on from ubuntu-latest to blacksmith-4vcpu-ubuntu-2404. Three repetitions, one simultaneous GitHub/Blacksmith pair at a time, preserve setup-node/npm cache behavior, four Vitest workers. Use run-created to aggregate completion and whole workflow duration including queue/setup; retain every failure. Dispatch intentionally skips unchanged npm publication and never publishes a release. Report that limit explicitly. Validate the eventual selected candidate in ordinary PR CI including publication.

Independently analyze hosted split file timings and scheduling, propose a small further balancing candidate, and compare it against the fixed baseline under the same conditions. Keep only measured gains, retain every case/assertion, and avoid timeout relaxation. Test the exact release verification command sequence on both providers with the normal default worker policy, without invoking release publication.

Use subagent-driven development for independent timing analysis, release measurement harness work, and final correctness/evidence review. Any production change receives regression tests, all bound verification commands, independent review, and draft-PR CI/review monitoring. No auto-merge, no modification of another author's PR154, and no bot-authorization expansion just to benchmark runners.
