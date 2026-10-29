# Preview uses host graphics when Chromium supports them

Preview requests GPU use with Chromium's `--enable-gpu` switch. Chromium discovers
its own graphics backend and keeps its driver blocklist, workarounds and software
fallback. Cezar does not detect VirGL, select ANGLE/Vulkan/OpenGL, scan devices,
start a display server, install drivers or add a setting.

The existing default was load-bearing for Preview on hosts without usable GPU
access. Preserve that guarantee: a missing display, inaccessible GPU or software
renderer must still produce frames. The existing argv test also pins sandbox
opt-in, direct networking and the private DevTools pipe; keep those assertions
while adding the GPU request. Launch deadlines, retries and process ownership stay
as they are. No new process or run state is introduced.

| Host case | Behavior with Preview enabled at shipped defaults |
| --- | --- |
| Usable GPU and display/backend | Chromium may accelerate canvas, compositing and rasterization. |
| No GPU, missing display or inaccessible device | Chromium falls back to software; Preview still streams. |
| Driver blocked by Chromium | Chromium keeps its blocklist and software fallback. |
| Hardware supports only some features | Chromium chooses per feature; no promise of hardware JPEG encoding. |
| Preview disabled | No Preview browser starts. |

Validation: assert the launch request without backend pins or disabled fallback;
launch real Chromium and receive a JPEG frame both in the inherited environment
and with Mesa forced to software and no display. Inspect `SystemInfo.getInfo` on
this host before and after the flag. Pin `proof_base` to
`5dc6a9197` and run the GPU argv regression against that source in a disposable
worktree; it must fail on the missing switch. Keep host-specific evidence in the
task handoff. Read all `chromiumArgs` callers and assertions; the UI and protocol
are unchanged.

## Evidence (2026-10-29)

- `proof_base`: `5dc6a919738c53996f07a247fa0c8b92e2835f0e`.
- Disposable worktree, new test and old source:
  `npm test -- packages/cezar/src/preview/chromium-gpu.test.ts -t 'requests headless GPU discovery'`
  failed as expected: argv did not contain `--enable-gpu` (1 failed, 2 skipped).
- Same worktree and test with the fixed `chromium.ts`:
  `npm test -- packages/cezar/src/preview/chromium-gpu.test.ts`
  passed all 3 tests, including real host and software JPEG streaming. Removed
  the disposable worktree after verification.
- The task worktree's Squeal results independently passed all 3 new tests.
- Host Chrome 156: old argv reported SwiftShader and software compositing;
  `--enable-gpu` alone reported the host's Mesa VirGL renderer with canvas,
  compositing and rasterization enabled. No ANGLE override was needed.
- `npm run typecheck` passed for all four workspaces; it also built the service.
