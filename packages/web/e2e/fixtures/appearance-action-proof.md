# Appearance native action regression (#795)

Run from the repository root after `npm ci`:

```
node --import tsx packages/web/e2e/fixtures/appearance-action-proof.ts desktop-theme
node --import tsx packages/web/e2e/fixtures/appearance-action-proof.ts phone-theme
node --import tsx packages/web/e2e/fixtures/appearance-action-proof.ts desktop-width
node --import tsx packages/web/e2e/fixtures/appearance-action-proof.ts phone-width
node --import tsx packages/web/e2e/fixtures/appearance-action-proof.ts desktop-theme --late-completion
```

Run cells serially. Each owns a local HTTP server, document, and native browser session and closes both on completion. The two-button geometry matches the Appearance segmented control chassis; theme and width cells exercise different semantic values and both viewport sizes. Density uses the same chassis at the audited ordinary setup sites.

The native-box wrapper returns the actual `getBoundingClientRect()` unchanged. In the geometry cells, its second read schedules a controlled `queueMicrotask` translating the group 60px before native pointer dispatch. Without the named Appearance readiness step, the captured center hits the prior button. With it, the unchanged 200ms geometry hold observes the shift and the original native selector click commits the requested value. The proof records trusted pointer/click events, selected radio, storage, and theme root state. It does not fabricate rectangles or dispatch DOM clicks.

The late-completion cell instead starts a real HTTP request whose response arrives after 400ms, beyond the existing 200ms hold. Completion moves the group and sets the fixture's ordinary setup idle flag. It asserts the trusted click followed completion; removing only the named readiness call makes this assertion fail even when the requested button was hit. No action timeout or hold is increased.

These are controlled class regressions. The historical worker-theme failure did not retain a pointer trace, so the fixture does not claim its original click hit the wrong button. The historical evidence establishes visible controls before later geometry completion; this fixture supplies deterministic semantic evidence for that ordering class.
