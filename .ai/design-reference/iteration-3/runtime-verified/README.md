# Current193 runtime baseline

193 frame inventory entries; 182 actual browser PNG captures. See gallery.html for identical CSS-size design/browser presentation. Original2xdesignPNGs remain unchanged.

These are baseline captures, not route acceptance. Specialized dialog/menu,disabled/empty/loading,resize and specimen-board states remain explicitly pending in inventory.json; no plain route screenshot is counted as evidence for an untriggered state. Current app is own source HEAD plus recorded Tools diff; otherworkers’ source changes are not integrated. Build proof compares92servedHTML/JS/CSS/font assets to localbuiltfiles.

Commands from worker e2fa worktree: node .ai/qa/runtime-verified/serve-fixture.mjs; node .ai/qa/runtime-verified/mock-api.mjs; node .ai/qa/iteration-3/capture-current.mjs; node .ai/qa/iteration-3/verify-current-build.mjs; node .ai/qa/iteration-3/build-gallery.mjs. Existing fixture server44629 runs with isolatedCEZHOME and dryrun. GitHub/automation response fixtures are disclosed in originalruntime-verified/mock-api.json. The localprojectdialog browses filesystem read-only; no project registration or cloning performed.
