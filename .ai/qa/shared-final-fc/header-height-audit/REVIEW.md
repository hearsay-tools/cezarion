# Desktop header height: current source resolution

Confirmed against current `cezarion.pen` SHA256 `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`, 193-frame manifest and actual source PNGs.

The source has two explicit desktop header geometries, not a universal 72px contract:

| Frames | Source header | Horizontal padding |
| --- | --- | --- |
| `mZMB8`, `Pusy6`: Start light/dark | 72px | 44px |
| `O2W1k`, `pf8QM`: New task starters light/dark | 72px | 44px |
| Shared master `DO42o` | 72px | 44px |
| 94 explicit page/session headers, including Skills, Workflows, Settings, Git/GitHub, task session, R1/R2 | 64px | 36px |

`source-heights.json` inventories all matching source nodes with frame and node IDs. Route frame geometry takes precedence over the generic component-board master.

Implementation `206dc392` changes only the shared `/new` desktop header to 72px/44px; other routes retain 64px/36px. Project-prefixed URLs use the existing stripped route pathname. The main scroll region occupies the next grid row, so its offset adjusts from64 to72 automatically on New task. `viewport-consumers.txt` records the audit of explicit64px viewport deductions: these belong to Git task/repo panes, whose source headers remain64. No route viewport override is needed or changed. Mobile remains52px. Session tab accent is untouched.

Nine fresh header PNG pairs cover all four affected source frames, Skills/Workflows both themes, and a real task session. `proof.json` asserts desktop header heights, horizontal padding and main y offsets in the built browser, plus unchanged mobile height. It records source/browser image hashes and all served index/asset hashes from the isolated populated CLI. Source is the previously frozen integrated parent b87b5082 plus the worker closeout and this header-only update; captures deliberately cover the shared header crop, not acceptance of other owners' route bodies.

`all-header-pairs.png` was visually inspected; each source crop is above its corresponding built crop. The Start header now matches both source height and inset. Existing branch/workspace labels render actual data rather than illustrative source copy. 89 shell tests and the web build pass. No full-suite rerun.
