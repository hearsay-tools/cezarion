# Parent/worker conversation cockpit QA

Date: 2026-09-08. Production build from this worktree, booted through `.ai/scripts/test-env-up.sh` with CEZ_DRY_RUN=1 and CEZ_HOME under `.ai/qa/cez-home`. Browser: native agent-browser 0.36.0, Chrome for Testing 151.0.7922.34, unique local session `qa-conversations-short-ba061944`. Container launch required `--args '--no-sandbox'` and TMPDIR=/tmp (the inherited task temp path exceeded Chrome's Unix socket limit). No user browser profile or real cezar home was used.

Fixture: two review records created with the real RunStore and projected with `projectConversationEvents`; parent `28e6ddaf-ee0c-4f2d-96dc-a84f802791af`, worker `63de167a-ad8a-4598-a2f2-b03afce193ce`. The parent has an unanswered human ask followed by a delivered request, delivered correlated worker reply, and replied outcome. This is a rendering/replay fixture, not a live provider execution claim. Review controls were not activated; the fixture has no provider session, so human answer controls correctly remain disabled while the question stays visibly unanswered.

Observed on the actual cockpit:

- 1440×1000 desktop and 360×640 mobile, both light and dark themes. Screenshots in this directory show the unchanged human ask, attribution cards, delivered state, correlated IDs, and replied outcome.
- Both sender and recipient links are keyboard focusable. Focus + Enter on the request recipient navigated to the worker's scoped task route. Focus + Enter on its sender link returned to the parent's scoped task route.
- After navigation and reload, each participant renders exactly two conversation cards with one outcome. No duplicate replay rows or synthetic human turn appeared.
- At 360 px the document has no horizontal overflow; each card's clientWidth and scrollWidth are both 334 px. UUIDs and multiline message text wrap inside their cards.
- Both transcripts expose delivery and request outcome; the parent's human ask remains labeled “The agent is asking” after the request reply.

QA found and fixed a real history bug: a worker whose transcript contained only conversation projections displayed “No session events yet”, because canonical history item classification omitted the new event types. A focused test reproduced itemCount=0, then passed with itemCount=2 after adding identity-based conversation/outcome/agent-input classification. Reloading the real worker route after rebuilding confirmed two cards and its outcome.

Validation: 179 focused tests passed across CLI, provision, thread reducer/rendering, relationship header, and event history. `npm run build` passed during the final test-env boot. Full integration and provider execution verification are tracked by the parent task.
