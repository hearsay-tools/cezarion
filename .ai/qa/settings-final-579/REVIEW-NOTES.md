## Layout corrections ready for integration

Apply **56b55310**, **50b9e946**, **11e22469** after the three previously integrated Settings commits. These changes stay under `routes/settings/` and scoped tests. Shared dependencies were consumed, not reimplemented.

- **S03:** the primary row now contains actual selected-agent files, deduplicated when one config also holds MCP. Claude shows `CLAUDE.md`, `settings.json`, and `MCP config`; its catalog does not claim to read `AGENTS.md`. A compact agent chooser and a visible scope/file section preserve every existing file action, group note, precedence/effect explanation, hosted read-only state, and versioned save. Reset/Save order and editor background follow the reference. Long file rows stay inside their columns.
- **S12:** compact installation and account readouts, the chosen account first, and separate action rows replace the oversized facts layout. Rename and Remove are visible for named accounts; Remove retains its confirmation. Identity is fetched only through Show details. The compact model editor has an explicit agent chooser that never changes the runner or another model. Account counts derive from actual records, including zero.
- **Settings controls:** scoped violet primary actions, white switch thumbs, regular button labels, spacing, and card/readout sizing follow the reference. Framework callbacks, focus behavior, authentication and mutation semantics remain intact. No help text or scope action was silently removed.

## Remaining behavior/state differences — actionable inventory

| Frames | Existing behavior retained | Correct way to reconcile the reference |
|---|---|---|
| **S03** · w1inBF, f7OdkB, v9iCdT, Sizxn | Files belong to selected agents; Claude does not read the catalog's AGENTS.md. User/local/project scopes and precedence remain editable/readable. Save/Reset require a dirty file and preserve the loaded version. | Use the real selected-agent labels; show a dirty-file state when depicting enabled Save. Keep scope/help controls in the reference rather than removing them from the application. |
| **S12** · XLiCf, giEbe, XvWFg, XalAH | Provider tabs select the actual account set. Discovered and added accounts both remain listed. Discovered accounts cannot be renamed/removed. Identity is opt-in; Connect launches the real sign-in flow and Recheck probes status, with no persistent authentication-progress event. | Use an idle/auth-needed reference for actual statuses. A simultaneous multi-provider composition or persistent progress panel requires an explicit navigation/lifecycle change; it is not a missing card style or unsupported account API. |
| **S06** · cv6mn, mQkaN, v5h5dm, U8r6vF; **S10** · sBaI8, OGJJ1, iBtG5, jCdnx | Template edits save the whole draft list; resource edits save independently. Composer defaults retain inherit/on/off. | Keep list-level/per-field save actions and three-state controls. A combined Save or binary-only defaults would change the requested existing behavior. |
| **S08** · f03Qc, P416t, n27mE, iI7Fo | The current appearance contract supports one Cezarion accent. | Remove obsolete Lime/Violet choices from the reference, or scope an actual appearance-contract change separately. |
| **S01** · PPxMw, x7yBQu, T4h3KX, Y9V5h2 | The running boot project cannot be unregistered. The populated fixture now has the reference's explicit project limit of 4. | An enabled Remove example must use a non-boot project. Do not enable a forbidden operation to match the picture. |

Real fixture paths, account/catalog counts, dates, syntax highlighting and shared header/sidebar content remain visible data/presentation differences; they are not represented as unsupported backend capabilities. The supplied shared shell is integrated. No design source was changed.

## Evidence and validation

`pairs.json` maps all **52 Settings frames**, with exact reference/browser SHA256, viewport, theme, comfortable density, 2× raster size, source hash and served build hash. `inventory-193.json` accounts for **193 confirmed frames**: 52 assigned captures, 141 outside this worker's scope. `gallery.html` provides the actual side-by-side PNGs. These are comparisons of the real implementation, not a claim that data-dependent pages are byte-identical to the source image.

The initial final Settings run passed **225 tests across 17 files**. The final affected account/model rerun passed **46 tests**, including the added empty-profile guard. Web typecheck and build/check:pack passed. New primary-row and visible-account-action guards fail against the previous source, while scope, versioned file saves, identity opt-in, account removal confirmation and independent default/model behavior stay tested. Full repository verification remains with the parent's assigned worker.

Real isolated-browser smoke verifies primary MCP selection, Reset/Save and restoration, mobile navigation, Add Project, actual account Rename/restoration, cancellation of Remove, and a model-agent chooser that leaves persisted defaults unchanged. No account authentication, identity lookup, account deletion, task launch, MCP execution or skill update occurs. `verify-evidence.mjs` checks all 52 PNG pairs and 105 served asset hashes including IBM TTF.

Fixture disclosure: real APIs supply configuration, file edits, projects and account records. Contract-validated browser responses supply synthetic installation/login validity and six-current-skills status, documented in `mock-proof.json`; they are disabled for the real account mutation smoke. The isolated registry seed is necessary because production correctly refuses to register descendants of Cezar task worktrees. No credentials are used or stored.
