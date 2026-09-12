# Implementation Partition Proposal — Iteration 2

## Summary
158 frames total. Baseline correction: all 158 unique frame names exist in `c3f4d228:cezarion.pen`; 151 normalized declarations changed and seven match, with shared font/variable changes also affecting rendering. The former 71-new / 2-changed / 85-identical claim used the wrong baseline and is withdrawn. See `../font-audit/README.md` and the corrected manifest. Partition suggestions below are historical proposals, not verified diff classifications.

## Priority Tiers

### Tier 0 — Shared Shell & Components (prerequisite for all)
These establish the visual foundation every page depends on.

| Frame | ID | Scope |
|---|---|---|
| Shared components | nXpJf | **content_changed** — reference sheet for all reusable parts |
| Shell / Desktop sidebar | (component) | Navigation items, project picker, session tree |
| Shell / Desktop header | (component) | Breadcrumb, worktree badge, actions menu |
| Shell / Mobile header | (component) | Hamburger, brand, project picker |
| 18. Appearance · Density | hkFbY | Reading-width and density behavior spec |
| 17. Sidebar indicators (×4) | t9WKAM, Y6ofnn, rCjjT, h1kN5a | Status badges, running/review/done states |

**Key reusable components (48 total):**
- Navigation: Item, Project disclosure, Session entry, Tracker reference, Search, Project picker
- Session: Tabs, Reply composer, Mobile reply composer, Worker summary, Expanded log
- Configuration: Execution panel, Runner+effort, Execution controls
- Controls: Switch, Run mode, Pickers (model/effort/runner/skill/template)
- Settings: Toggle, Value picker, Category link, Labeled value
- Tasks: Summary row (desktop + mobile), Badge/Status
- Files: File row, Folder row (desktop + mobile)
- Git: Commit row (desktop + mobile)
- Code: Diff excerpt

### Tier 1 — New Feature Pages (71 new frames)
Completely new views with no existing implementation.

#### 1A. Inbox & Automations (6 frames)
| Frame | ID | Theme | Viewport |
|---|---|---|---|
| 19A. Inbox · Follow-up review | lwULN | light | desktop |
| 19A. Inbox · Follow-up review · Dark | yrCXo | dark | desktop |
| 19A. Inbox · Mobile light | pubJt | light | mobile |
| 19A. Inbox · Mobile dark | K6EBZm | dark | mobile |
| 20A. Automations · List and activity | vFhip | light | desktop |
| 20A. Automations · List and activity · Dark | vHYVq | dark | desktop |
| 20B. Automations · Editor | Q0JpNn | light | desktop |
| 20B. Automations · Editor · Dark | hegUC | dark | desktop |
| 20B. Automation editor · Mobile light | Y9GMYF | light | mobile |
| 20B. Automation editor · Mobile dark | UIfcs | dark | mobile |

#### 1B. Variant Comparison & Plan Review (6 frames)
| Frame | ID | Theme | Viewport |
|---|---|---|---|
| 21A. Variant comparison · Results | E2pFB | light | desktop |
| 21A. Variant comparison · Results · Dark | NkEDk | dark | desktop |
| 21A. Compare variants · Mobile light | sA0J5 | light | mobile |
| 21A. Compare variants · Mobile dark | tV7Vf | dark | mobile |
| 22A. Plan review · Reorder and start | rwgD6 | light | desktop |
| 22A. Plan review · Reorder and start · Dark | iVNMT | dark | desktop |
| 22A. Plan review · Mobile light | y6mdNp | light | mobile |
| 22A. Plan review · Mobile dark | D5ua2 | dark | mobile |

#### 1C. New Task & Navigation Enhancements (6 frames)
| Frame | ID | Theme | Viewport |
|---|---|---|---|
| 23A. New task · Starters and follow-ups | HU3Q7 | light | desktop |
| 23A. New task · Starters and follow-ups · Dark | R5A7rF | dark | desktop |
| 24A. Shared navigation · Optional tools | AvnOO | light | desktop |
| 24A. Shared navigation · Optional tools · Dark | ZFjwR | dark | desktop |

#### 1D. Enhanced Tables & GitHub (18 frames)
| Frame | ID | Theme | Viewport |
|---|---|---|---|
| 25A. Project tasks · Full resource table | o4b4a2 | light | desktop |
| 25A. Project tasks · Full resource table · Dark | KHzma | dark | desktop |
| 25B. Project tasks · Mobile floating New task | F9bVC | light | mobile |
| 25B. Project tasks · Mobile floating New task · Dark | ZZg1y | dark | mobile |
| 26A. All tasks · Grouping, tags | J2T61f | light | desktop |
| 26A. All tasks · Grouping, tags · Dark | utdkB | dark | desktop |
| 27A. GitHub · PR conversation, filters | MAoLU | light | desktop |
| 27A. GitHub · PR conversation · Dark | T95KVV | dark | desktop |
| 27B. GitHub PR · Changes, blocked merge | aMnx1 | light | desktop |
| 27B. GitHub PR · Changes · Dark | t6Imv | dark | desktop |
| 27B. PR changes and merge · Mobile light | KVEBF | light | mobile |
| 27B. PR changes and merge · Mobile dark | C2LEL | dark | mobile |
| 27C. GitHub PR · Checks passing (×4) | BeRrd, FPdeC, z7LPU8, e9APk2 | both | both |

#### 1E. Task Actions & Dialogs (12 frames)
| Frame | ID | Theme | Viewport |
|---|---|---|---|
| 28A. Task actions · Menu and handoff reader | dABhL | light | desktop |
| 28A. Task actions · Menu · Dark | Fsizd | dark | desktop |
| 28A. Task actions · Mobile light | DgFDf | light | mobile |
| 28A. Task actions · Mobile dark | xHfq2 | dark | mobile |
| 29A. Confirmation dialogs · Tasks, variants | ghWjg | light | desktop |
| 29A. Confirmation dialogs · Dark | uSLd4 | dark | desktop |

#### 1F. Detailed Settings Pages (16 frames)
| Frame | ID | Theme | Viewport |
|---|---|---|---|
| 30A–D. Project settings subtabs (×8) | t0g2h, TN9Ej, eDIGx, FQr7q, PBf5F, e2S835, SRaON, PxeWg | both | desktop |
| 31A–E. Global settings subtabs (×10) | Z9By1, HVu0D, AzGdn, chAPL, AN5gN, xH7vU, Sa02O, XS7nt, SN7pd, lUOHx | both | desktop |
| 31B. Resource settings · Mobile (×2) | hcJW7, Y3hl1v | both | mobile |

#### 1G. Workflow Editing & Optional States (8 frames)
| Frame | ID | Theme | Viewport |
|---|---|---|---|
| 32A. Workflow editing · Import, Add, Delete | TYwHz | light | desktop |
| 32A. Workflow editing · Dark | vxfF8 | dark | desktop |
| 32A. Import workflow · Mobile (×2) | cpiTh, d0G4G | both | mobile |
| 33A. Optional features · States | gHoB0 | light | desktop |
| 33A. Optional features · States · Dark | lzI1Q | dark | desktop |

#### 1H. Index/Meta Frame
| Frame | ID | Notes |
|---|---|---|
| 00B. Implementation gaps | eGAZH | Coverage index, non-implementable |

### Tier 2 — Content-Changed Baseline Frames (2 frames)
These exist in the codebase but their design content was updated.

| Frame | ID | Change |
|---|---|---|
| Shared components | nXpJf | Reference sheet updated (new components added) |
| 2A. Task session · Desktop light | gC8ds | Session view content updated |

### Tier 3 — Identical Baseline Frames (85 frames)
Already implemented from previous iteration. Use for regression testing only.
Frames 1A–16D plus frames 17–18 and 10.Run/Skill/Manage/11.Workflow.

## Verification Coverage Proposal

| Area | Screenshot frames | Verification approach |
|---|---|---|
| Shell/nav (light+dark, desktop+mobile) | gC8ds, RWNTz, StTvu, SAzUR, Qwe6U, YJIDa | Side-by-side: sidebar icons, search, project picker, session tree |
| Start/New task | xD5Vz, NMS9D, twLlb, qtABD, HU3Q7, R5A7rF | Composer layout, buttons, execution settings |
| Session | gC8ds, RWNTz, StTvu, SAzUR, Dr8VY, HJtbl | Tabs, breadcrumb, message bubbles, reply composer |
| Tasks table | vmodY, Bs14b, cKQLR, zExdi, o4b4a2, KHzma | Row layout, status badges, column menu, resource columns |
| All tasks | WoTim, BmuxZ, bticP, Y2moBg, J2T61f, utdkB | Grouping headers, tag pills, action menu |
| Git tabs | 6 Changes + 6 Commits + 6 Branches + 2 Task variants each | Diff excerpts, commit rows, branch rows |
| GitHub | pV64O, ZUfRo, Oe3RJ, WgKmT + 27A/B/C variants | PR conversation, checks, merge states, readiness |
| Skills | JfXUf, WygR0, md67O, FaZPm + Run/Detail/Manage variants | Skill cards, detail overlay, manage list |
| Workflows | S446C7, e0YGQ, DZvRy, vLA8k + Auto/Edit variants | Step cards, YAML, import dialog |
| Settings (project) | 12A–D + 30A–D | Category links, form controls, agent config |
| Settings (global) | 13A–D + 31A–E | Notifications, resources, skills, accounts, projects |
| Inbox | lwULN, yrCXo, pubJt, K6EBZm | Follow-up cards, actions, runner badges |
| Automations | vFhip, vHYVq, Q0JpNn, hegUC | List, editor, mobile |
| Variants/Plan | E2pFB, NkEDk, rwgD6, iVNMT | Comparison grid, reorder controls |
| Overlays/Dialogs | ghWjg, uSLd4, dABhL, Fsizd | Menu items, confirmation buttons, handoff reader |
| Optional states | gHoB0, lzI1Q | Disabled, empty, waiting states |

## Implementation Ownership Suggestion

| Owner | Scope | Frame count |
|---|---|---|
| Agent A (Shell) | Tier 0: shared nav, shell components, sidebar indicators, appearance | ~10 frames |
| Agent B (Features) | Tier 1A–C: Inbox, Automations, Variants, Plan review, New task | ~24 frames |
| Agent C (Tables/GitHub) | Tier 1D: Enhanced tables, GitHub PR views, 27C checks | ~18 frames |
| Agent D (Settings/Dialogs) | Tier 1E–G: Task actions, dialogs, settings subtabs, workflows | ~36 frames |
| Agent E (Verification) | Tier 2–3: Regression coverage for all 87 existing frames | 87 frames (verify only) |
