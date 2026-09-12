# Initial ownership slices (audit in progress)

Source e9cd6a2; source build and font verification passed. Existing screenshots are baseline captures, not declarations of visual acceptance. Design PNGs are exported at 2×; browser CSS viewports use pen frame dimensions.

| Suggested slice | Design frames | Concrete review points |
|---|---|---|
| Task session + activity + task changes/files/commits | 2, 3, 14–16, 22, 28–29 | Session has narrow centered transcript at default reading width; design uses wider column. Preserve width preference. Verify task header, worker strip, activity disclosure, continuation composer, actions/handoff and confirmation dialogs with populated fixtures. |
| Task overview + all tasks | 4–5, 25–26 | At 1440 comfortable, current table exposes status + all resource columns by default, compressing workflow to quick-ta… and memory to peak 42…. Design 4 uses roomy task/status rows and five summary columns; frame 25 separately covers full resource columns. Preserve column chooser and resource access. |
| Git + GitHub | 6–9, 27 | Compare real populated diff/commit/branch fixtures. GitHub browser mocks provide PR list/conversation/checks/changes without external calls. Readiness-unknown frame 27C must stay distinct from ready. |
| Skills + workflows | 10–11, 32 | Workflow requires selected saved fixture chain, not empty editor. Skills detail/manage and Auto dialog require explicit interaction captures. |
| Settings | 12–13, 30–31 | General index is /settings, separate from /settings/agents. Capture each registry section, plus density/reading width variants. Do not interpret wrong selected subsection as an implementation gap. |
| Optional flows + navigation | 17–24, 33 | Follow-up inbox, automation list/editor/log, plan review and comparison need populated specialized states; shared shell owner remains unchanged. |

Evidence directory: pairs/<frame-id>-browser.png and pairs/<frame-id>-design.png. inventory.json records what was actually captured; pending rows are not coverage.