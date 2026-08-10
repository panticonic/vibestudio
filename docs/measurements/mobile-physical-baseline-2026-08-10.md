# Mobile physical-device baseline — 2026-08-10

Device: Pixel 9a connected over trusted USB (`adb` serial intentionally omitted).
Host: Linux development checkout, Electron-owned ephemeral `dev` workspace.
Scenario: `onboarding-desktop-mobile-install-android` through the internal
system-test/eval surface. Full trajectories remain in the private system-test
artifact directory and are not reproduced here.

## Retained runs

| Run                                   | Harness result |  Duration | Product observation                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | -------------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `st_8485da45daa74a7aac1173ee2b853740` | pass           | 132.378 s | Source APK installed, trusted pairing completed, bundle activated, workspace connected. An exact 1 MiB artifact range arrived 20 bytes short and required integrity-guarded retries.                                                                                                                                                                                                       |
| `st_897e3d4e31ca45e19ab45bfd0a6c9a6d` | pass           | 124.439 s | Same end-to-end success. The installed APK still contained the old 1 MiB client window, proving the Android bundle task did not track Metro's monorepo/workspace source roots.                                                                                                                                                                                                             |
| `st_7e89a86712bb40dcb2812312656e3978` | validator fail | 136.288 s | Product path succeeded after a real APK rebuild: ranges were 524,288 + 524,288 + 96,419 bytes, with no transfer retry; trusted pairing, authentication, panel façade/host readiness, and workspace connection all completed. The validator failed because Android/platform and paired-device fields appeared in identity-preserving projections of the same result rather than one object. |

The third run's validator defect has a permanent regression in
`workspace/skills/system-testing/tests/scenario-semantic-validators.test.ts`.
The fixed validator requires paired Android evidence and a structured paired
device, but permits those facts to be split across the evaluator's concise and
raw projections of one execution result.

## Transfer finding

The physical React Native delivery boundary is not reliably inclusive at one
MiB. In the first two runs an exact 1,048,576-byte application range repeatedly
lost 20 bytes (one mux header per 256 KiB transport segment). The integrity
guard correctly rejected the partial body, so this was not corruption, but a
retry path is the wrong steady state. A 512 KiB application window completed in
three bounded ranges without retry in the rebuilt third run.

## Build and cleanup resources

During the cold Android bundle rebuild, sampled high-water resident memory was
approximately 1.33 GiB for Gradle's documented single-use daemon and 1.22 GiB
for Metro. Both were transient. The build uses `--no-daemon`, in-process Kotlin,
and a two-worker Metro cap; the follow-up Gradle task was up-to-date and ended
with `BUILD SUCCESSFUL`.

Closing the first test Electron launcher exposed two distinct lifecycle defects:

1. an ephemeral Electron-owned hub inherited the persistent hub's keep-on-quit
   policy; and
2. terminal signals killed Electron before its asynchronous quit cleanup.

After making ephemeral ownership imply stop and routing the development
runner's first signal through Electron's canonical `app.quit()` path, the live
proof emitted `Shutting down` → connection closure → `Hub stopped` →
`Shutdown complete`. A post-exit process audit found no owned Electron hub,
Gradle daemon, Kotlin daemon, Metro worker, or RN-provider temporary directory.

A later audit found a separate headless-renderer leak: an orphaned Chromium tree
retained multiple old chat targets and roughly one renderer pair per historical
panel context. `PageHost.unloadPanel()` closed the panel target but never
disposed its owned incognito browser context, so Chromium-owned toolbar targets
and processes survived panel churn. The exact orphan was stopped, and the host
now disposes a context when its final panel unloads; the focused lifecycle test
asserts both `Target.closeTarget` and `Target.disposeBrowserContext`. The stale
managed `system-test` instance that owned a hub/workspace/workerd tree was also
stopped through its instance-scoped supervisor command. The subsequent audit
found no headless Chromium, managed system-test, Gradle, Kotlin, or Metro
processes from this work.

## Visible phone state

After the Electron provisioning run, the phone showed the selected
`panels/chat` workspace panel and the intentional ownership handoff:
`Running on Desktop` with a `Take over` action. This distinguishes a connected
but desktop-owned panel from the earlier blank `about-new` failure.

## Limits of this baseline

- These are exact onboarding runs, not a statistically meaningful latency
  distribution.
- High-water memory was sampled from the host process tree rather than PSS.
- The physical-device runs predated the durable-store recovery proof. A later
  Android emulator run covered the same paired app and named workspace through
  both an app cold start and a server restart. Each recovery rendered a
  nonblank panel with zero panel-asset pipe misses; the server-restart entry
  document was served as a native `workspace-panel-asset-store-hit`.
- The deployed hosted-signaling and full-relay smokes passed earlier in the
  investigation, but they are not assigned run IDs here because those executions
  predated the retained exact system-test artifacts above.
