The cockpit now follows the approved193-frame design across task creation, sessions, task lists, Inbox, Automations, Plan, Variants, Git/GitHub, Settings, Tools and shared Skills/Workflow surfaces, while preserving existing task and project controls.

Plan review is embedded in its page canvas with draft/focus restoration and unchanged edit, reorder, save, overwrite and start behavior. Scoped fixes restore offline task fallback, contain the accessible Automation legend, keep switch thumbs visible, preserve44px hit targets, and distinguish GitHub bypass/conflict warnings. Browser tests use actual control readiness, effective hit areas and settled pointer interactions without dropping behavioral assertions.

Verification:

- Typecheck and build pass;386root test files/8,011tests,261unit tests and27package tests pass.
- Complete browser suite:43files,373passed,6existing skips,0failed.
- Parent integration matches979 tested package/script and root build/test inputs byte-for-byte; no redundant rerun.
-193references are accounted for by the owned independent audit and fc’s36-reference shared review, with explicit route, component and state evidence. See `.ai/qa/final-integrated/ACCEPTANCE.md`.

Real fixture data and existing controls remain intact. Global Changes has no API diff total; PR assignee/board metadata is issue-only; historical per-turn runner/handoff timestamps are unavailable. New Task23 versus legacy1, grouped Tasks26 versus5, dedicated Inbox19B versus compact33, and composite29/33 states are explicitly distinguished; incompatible variants are not claimed simultaneously pixel-matched.
