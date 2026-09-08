# Rebalance optimized test shards

User authorization: improve the optimized shard balance; open a separate draft PR only after measurements prove an improvement.

1. Compare current and refreshed optimized duration weights on fixed main 76429dcf, three hosted repetitions each.
2. If the single longest suite limits improvement, evaluate splitting only worker-wait.test.ts using the already preserved experiment's three scenario groups. Keep every case, assertion, cleanup hook and production source unchanged. Reuse shared test fixtures; no concurrent tests.
3. Use subagent-driven development for the independent narrow split/coverage check while the coordinator measures and reports results. Independent code review must check test preservation.
4. Compare maximum shard elapsed time, imbalance, aggregate runner usage, resources and failures. Preserve raw reports and reject unsupported changes.
5. For a proven candidate, run full repository verification, open a draft PR based on main, and monitor final CI and automated review. Keep provider migration outside this work.
