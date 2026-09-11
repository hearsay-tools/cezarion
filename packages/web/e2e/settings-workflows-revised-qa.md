# Settings, Skills and Workflows — revised reference verification

Issue #224. Reference: the parent's updated `cezarion.pen`, with PNGs and page-subtree
extracts in `.ai/design-reference/revised/`. This supersedes the earlier frame IDs in
`skills-workflows-design-qa.md`; no design source was copied into this worker.

## Coverage

| Frames | Implementation / retained behavior |
| --- | --- |
| 30A `ur8ZK` | Agents section card, stacked full-width model fields and prompt. Provider enablement/authentication remains first, including its deep-link anchor and existing tests. Runner/account selection, native model locking, live titles, review gate, base branch and saves remain intact. |
| 30B `w1inBF` | Agent-specific tabs and compact, wrapping file selectors above the full-width editor. Every existing scope, precedence note, read-only rule, conflict check, exact text save and JSON error remains available. Syntax-layer textarea stays transparent. |
| 30C `LmL0v` | Retention field and vertical worktree records retain status, size, age, branch and deletion/reclamation confirmations. Open folder uses the existing run API only when local file-manager discovery supplies a target. |
| 30D `cv6mn` | Labeled template name/instructions, skill associations, separated records and New template form. Removal remains a draft edit; the existing collection Save/Reset behavior is unchanged. |
| 31A `x1Iye` | Notification section card, current browser permission and mobile stacking. Allowed, blocked and unsupported are actual runtime alternatives; permission is requested only on enable. |
| 31B `sBaI8`, mobile `OGJJ1` | Full-width limits, wake-up and auto-resume switches, wake interval and memory controls, stacked defaults. Monitoring still saves explicitly; auto-resume still saves immediately. Inherit/On/Off defaults stay three-way controls because inheritance is real behavior. |
| 31C `RysDF` | Automatic-update preference, actual installation status, default restoration and Open Skills navigation to the discovered boot project. Unavailable reasons are conditional server state. |
| 31D `XLiCf` | Section card, wrapping provider tabs, account/native authentication flows and defaults. Existing per-agent tabs, opt-in identity details, discovered-account protection and native sign-in are retained. No credentials are fabricated or exposed. |
| 31E `Id0Gw` | Full-width folder inputs and vertical project records with tags, concurrency, status, dates and existing actions. Per-folder save behavior and boot-project removal protection stay intact. |
| 32A `lRC5W`, mobile `djknR` | YAML import/error, selectable/filterable Add step dialog, delete/overwrite confirmations. Import errors keep the text. Closing Add step returns keyboard focus to its trigger. |
| 10 `EKi57`, `cvBro`, `f2LGv`, `gqaUM` | Inspected catalog, reader, Manage skills and bookmarklets against updated PNGs. Existing structures and actions retained; tested in both themes and at all three widths. |
| 11 `C2sfEo`, `s0JzCL`, Auto `VDDSI` | Number is the real keyboard/pointer drag handle; ellipsis opens removal. Explicit mobile Move up/down remains. Specific prompts precede catalog descriptions; generic `{{task}}` keeps the useful catalog description. Command type/retry information lives below the summary. |
| 12/13 `PPxMw`, `aFFvV`, `oHH3V` | Scope heading, text-only section navigation, section cards and local-storage summary. Settings now consumes the existing reading-width token; default Narrow remains 820px. |

Shared shell, global typography, primitive button colors and sidebar are the parent's scope.
Actual server capabilities and save contracts take precedence over simplified fixture controls.
The implementation does not render alternate permission/authentication/error states simultaneously.

## Verification

- Focused web suite: 349 tests across 21 files passed.
- Web typecheck and server/web builds passed.
- Red-before-green checks covered step prompt precedence, generic prompt fallback, menu removal,
  Add step selection/cancel/focus restoration, resource switch behavior, Open Skills and Open folder.
- Existing E2E selectors follow actual relocation: removal trigger is now the ellipsis;
  command/retry information is below the summary; monitoring uses a switch. Assertions for
  wrapping, keyboard focus, command/retry content and persistence remain.
- Fixture browser matrix: 84 captures across 14 views × 1440/402/360px × light/dark;
  final matrix found no horizontal overflow. Comfortable density, Wide reading width.
- Supplementary browser checks passed for menu keyboard access, dialog focus restoration,
  MCP parser-error draft retention and transparent syntax layer, local folder target dispatch,
  Skills navigation, Narrow 820px measure and reduced-motion Add step.
- Additional captures cover import parser errors and empty/loading/error states.

Evidence and replay drivers (local to this task):

- `/tmp/fd-settings-evidence/` — named PNGs and `findings.json`.
- `/tmp/fd-settings-browser.cjs`, `/tmp/fd-settings-extra.cjs` — isolated API-fixture drivers.
- `/tmp/fd-final-tests.log`, `/tmp/fd-typecheck.log`, `/tmp/fd-server-build.log`,
  `/tmp/fd-web-build.log`, `/tmp/fd-browser.log`, `/tmp/fd-extra.log`.
- Native agent-browser E2E: 8 tests passed across `workflows.e2e.ts` and `settings-monitoring.e2e.ts`; `/tmp/fd-e2e.log`. The import action is scrolled into the nested viewport before clicking, and theme contrast is measured after transitions settle. No thresholds or persistence assertions were removed.

Recheck after integrating the parent's shared shell and primitive changes. Fixture screenshots
prove these interiors and state transitions, not a pixel-identical match of arbitrary repository
content or an authenticated provider session.
