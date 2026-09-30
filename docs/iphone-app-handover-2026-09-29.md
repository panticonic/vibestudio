# iPhone app handover — 2026-09-29

**Current status (2026-09-30):** Release/Debug simulator installation, pairing,
System approval, streamed mobile activation, real workspace panel rendering,
navigation, message submission, model output, and server restart recovery have
been exercised on the isolated iPhone. Computer Use works with the screen awake.
Native nullable-value and WebView script/message ownership repairs are published;
Hosted CI now passes all 13 native tests together. Panel canvases remain edge to
edge; safe spacing is panel-owned, with optional measured viewport insets and
corner hints. Touch composer/settings repairs are pushed to Base and System;
combined live keyboard/rotation acceptance is in progress. Physical
hardware and distribution accounts remain unavailable. Read the latest checkpoint
below; earlier sections are historical.

## Original stopping point: 2026-09-29

The user wants the entire Vibestudio iPhone app experience completed and tested,
following the previously tested Android experience. They authorized autonomous
setup, builds, investigation, and fixes. They have now explicitly asked this
agent to stop work and provide this handover. **They explicitly said not to stop
the iOS simulator runtime download. Leave that download running.** They then
asked that anything useful for preparation continue in the background. A native
dependency refresh followed by compilation was started under that authorization.

The task is incomplete. No successful iOS build, simulator launch, pairing, or
physical-iPhone test has been established. Resume with the native dependency
update and Release build results below; do not interpret host tests as iPhone acceptance.

## Background preparation started at handover

In addition to the runtime download, a sequential preparation process is running:

1. `pod update fmt RCT-Folly` against the now-installed fmt 12.1.0 pod declarations.
2. **Only if the update succeeds**, the unsigned generic Release simulator build
   documented below.

The tool execution session ID is **5028**. Inspect these logs before starting
another CocoaPods or Xcode build process in this project:

- Dependency refresh: `/tmp/vibestudio-ios-pod-update-20260929.log`
- Subsequent build: `/tmp/vibestudio-ios-prepared-build-20260929.log`

The build log may not exist until the dependency step succeeds. Initial startup
returned a live session; neither step had completed when this document was
updated. A zero exit from the entire process confirms compilation; errors require
investigation by the next agent. This process may update Podfile.lock, generated
Pods files, the privacy manifest, and the integrated Xcode project. It does not
start a simulator, app, or server. No automated code repair was queued.

## Environment and ongoing process

- Repository: `/Users/gabe/vibestudio` on an Apple Silicon Mac.
- Full Xcode is now installed at `/Applications/Xcode.app`:
  `Xcode 27.0`, build `27A266a`.
- The user accepted Apple's license. `xcodebuild -checkFirstLaunchStatus`
  subsequently exited successfully.
- Global `xcode-select -p` still points to `/Library/Developer/CommandLineTools`.
  All successful native tooling in this session used
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` explicitly.
  No global developer-directory change was made.
- CocoaPods 1.17.0 was installed through `brew install cocoapods`, with approval.
  Homebrew also installed/upgraded its Ruby, libyaml, OpenSSL, and CA dependencies.
- Xcode lists iOS 27.0 device and simulator SDKs. At initial discovery, there were
  no installed simulator runtimes or simulator devices.
- **Ongoing download:**
  `env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -downloadPlatform iOS`
  is downloading iOS 27.0 Simulator, build `24A434`, arm64, approximately 8.05 GB.
  Last observed progress was **51.7% / 4.16 GB**. Its tool execution session ID
  was `26517`; it remained running at handover. A next agent may not retain
  access to that session ID, so discover current runtime/download state directly.
  Do not start another download or terminate it without checking its state.
- No owned simulator, app, Metro server, or Vibestudio server was started.
  Earlier CocoaPods, Swift resolution, pnpm, and build processes completed;
  the new preparation process described above remains running.
- The heartbeat automation `resume-iphone-testing-after-xcode-installs` is
  **PAUSED**. It was paused while waiting for license acceptance and was not
  resumed after the user's reply. Keep it paused while handing off to avoid
  concurrent agents changing this work.
- Simulator access from the filesystem sandbox failed with CoreSimulator XPC
  connection errors. Running the same discovery outside the sandbox succeeded.
  This was a sandbox boundary, not evidence of a broken Xcode installation.

## Completed work

### Simulator install correctness

Changed `scripts/cli/mobile-install.mjs` and added
`scripts/cli/lib/mobile-ios.mjs` plus its `.d.mts` declaration:

- Resolve exactly one available, booted iOS simulator from `simctl` JSON.
- Use its same UDID for the Xcode destination, boot readiness, install, and launch.
  Previously the build targeted a hard-coded iPhone 16 while installation used
  the arbitrary `booted` target.
- Exclude other Apple simulator platforms and unavailable devices.
- Fail clearly when there is no booted simulator or more than one.
- Reject simultaneous `--simulator` and physical `--device` arguments.
- Select the SDK explicitly and disable code signing for simulator builds.
- Check `xcodebuild -version` before generating entitlements or installing pods.

`tests/mobile-ios.test.ts` covers model-independent selection, unavailable and
non-iOS devices, no booted simulator, and ambiguous selection.

### Honest verification documentation

Updated `apps/mobile/ios/README.md` and `docs/ios-integration-plan.md`:

- Native host ABI is `rn-host-5`; the old integration record still said `rn-host-3`.
- Corrected the claim that iOS end-to-end smoke exists.
- Added an iPhone acceptance checklist and explained simulator versus device signing.
- Corrected the unsupported app-local typecheck command to a host-owned template
  projection command.

**Documentation caveat:** the "Local checkpoint" paragraph in
`docs/ios-integration-plan.md` still describes the earlier environment without
Xcode or CocoaPods. This handover supersedes that paragraph. Update it when
recording the next actual build/run result.

### Native provisioning and deployment floor

- Initial `pod install` succeeded: 90 dependencies, 99 total pods.
- Resolved the pinned IrohLib Swift package at version 1.1.0, revision
  `5e451092dba0c1a09ee83ff6e5be37b1152a5c58`.
- Its package manifest requires **iOS 17.5**, while our native project and Podfile
  declared 17.0. Updated all app/project deployment targets and the Podfile's
  platform/post-install target floor to **17.5**. Updated the README accordingly.
- CocoaPods rewrote `Vibestudio.xcodeproj/project.pbxproj` as part of normal
  integration. This includes the Pods library, Firebase build script, privacy
  manifest resource, and the correct monorepo `REACT_NATIVE_PATH`. Review the
  generated diff; do not blindly revert it or regenerate the app project.
- Added `.xcode.env.local` and `xcuserdata` ignores in the iOS `.gitignore`.
  `.xcode.env.local` was generated with this Mac's Node path and is machine-local.
- Newly generated, currently untracked native files include `Podfile.lock`,
  the CocoaPods `.xcworkspace`, Swift `Package.resolved` files, and the aggregated
  `Vibestudio/PrivacyInfo.xcprivacy`. Review which reproducible project/lock inputs
  belong in source. Do not commit machine-local user state or Pods/build output.

## Actual build failure and prepared dependency repair

The only actual compile attempt was an unsigned **Release simulator build**,
using a generic simulator destination while the runtime downloaded:

```sh
cd /Users/gabe/vibestudio/apps/mobile/ios
env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -workspace Vibestudio.xcworkspace -scheme Vibestudio \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build -clonedSourcePackagesDirPath build/SourcePackages \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGN_ENTITLEMENTS=Generated/Vibestudio.entitlements \
  -quiet build
```

It exited **65**. Full captured output:
`/tmp/vibestudio-ios-build-20260929.log`.

The concrete errors were in `Pods/fmt/include/fmt/format-inl.h`, at lines
59, 60, 1387, 1391, and 1394: `call to consteval function ... is not a constant
expression`. Installed React Native is **0.79.7**, which pins **fmt 11.0.2**.
This matches the upstream compiler incompatibility documented in:

- [React Native issue 55601](https://github.com/react/react-native/issues/55601)
- [fmt issue 4740](https://github.com/fmtlib/fmt/issues/4740)
- [React Native fmt version upgrade proposal](https://github.com/react/react-native/pull/56225/files)

The prepared repair upgrades the iOS dependency to the upstream **fmt 12.1.0**
release. It does not disable `consteval` or edit downloaded fmt headers.

- Added `patches/react-native@0.79.7.patch` through pnpm's dependency patch workflow.
- The patch updates the fmt pod version/tag and **all React Native podspecs**
  requiring fmt 11.0.2 to require 12.1.0 consistently.
- Registered it in `package.json` under `pnpm.patchedDependencies`.
- Updated `pnpm-lock.yaml` using the repository's exact **pnpm 10.12.4**.
- Confirmed installed `node_modules/react-native/third-party-podspecs/fmt.podspec`
  and `ReactCommon/jsi/React-jsi.podspec` now declare 12.1.0.
- The Android fmt version in React Native's Gradle declarations was not changed.
- Temporary editable dependency source remains in
  `.cache/react-native-ios-upgrade`; the durable source is the patch file.

**Critical next step:** at preparation startup, installed CocoaPods and
`Podfile.lock` still reflected **fmt 11.0.2**. The dependency repair was applied
only after the last successful `pod update`. The background preparation process
is now updating CocoaPods before rebuilding. Check its results; there has been
**no completed build or test after the final dependency repair**.

### pnpm version pitfall

The globally installed Homebrew `pnpm` is **11.0.5**, despite the repository's
`packageManager: pnpm@10.12.4`. Its patch command recorded package.json settings,
but its install did not apply that package.json patch configuration or update
the lockfile. Using the pinned version explicitly fixed this:

```sh
npx --yes pnpm@10.12.4 install --ignore-scripts
npx --yes pnpm@10.12.4 patch-commit .cache/react-native-ios-upgrade
```

Both completed. The latter ran the repository's Husky prepare hook. The lockfile
diff primarily propagates the React Native patch hash through its peer consumers.
pnpm warned about the existing `packages/mobile-iroh` React 19.2.4 versus RN's
React 19.0.0 peer requirement; this has not been investigated here.
pnpm also alphabetized the existing `extract-zip` entry in root devDependencies;
that incidental ordering change is not a functional part of the iOS repair.

## Verification evidence

Before the native provisioning/dependency edits, 29 distinct focused host tests
passed across these files:

```text
tests/ios-entitlements.test.ts                 4
tests/mobile-dev-script.test.ts               2
tests/mobile-device-tools.test.ts             3
tests/mobile-native-iroh-contract.test.ts      3
tests/mobile-connect-link-router.test.ts      8
src/server/services/mobileNativeService.test.ts 5
tests/mobile-ios.test.ts                      4
```

Run with `node_modules/.bin/vitest run --config vitest.host.config.ts ...`.
The selector's tests were run after its implementation. Native deployment-target,
project-integration, and fmt dependency edits happened later and remain unverified.
The earlier command also named `tests/mobile-native-asset-store.test.ts`, but the
host configuration excluded it; **do not count it as executed**.

JavaScript syntax, formatting, and diff whitespace were checked earlier.
They were not rerun against all final native/dependency edits before handover.

## Suggested continuation

1. Read the repository `AGENTS.md` and preserve the user's first-principles
   requirement: repair the source/dependency design; do not disable checks or
   build a partial test that is labeled as end-to-end success.
2. Check whether the existing runtime download has finished. Keep using the
   explicit `DEVELOPER_DIR`; access CoreSimulator outside the sandbox when needed.
3. Inspect the background preparation logs and wait for its completion. Do not
   run concurrent dependency updates/builds against this same project. If the
   preparation needs to be retried, from the **host** iOS project directory:

   ```sh
   cd /Users/gabe/vibestudio/apps/mobile/ios
   env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
     pod update fmt RCT-Folly
   ```

   Inspect any resolution failure. Verify the resulting lockfile and installed
   fmt headers actually use 12.1.0, with a consistent React Native dependency
   graph and iOS 17.5 floor. Do not modify Pod headers to mask version conflicts.

4. Rebuild Release with the command above and inspect the first concrete error.
   Entitlements are already generated under the ignored `Generated/` directory;
   regenerate with `node scripts/cli/ios-entitlements.mjs --configuration Release`
   if needed. Do not call compilation successful until Xcode exits zero.
5. After the runtime installs, create an isolated, uniquely named iPhone simulator,
   boot it, and use `mobile-install.mjs --platform ios --simulator --launch`.
   Keep only the intended iOS simulator booted for this CLI selection policy.
   Own and shut down only the simulator/server processes you create.
6. Verify the bundled Release bootstrap without Metro, then the Debug/Metro loop.
   Pair against an isolated Vibestudio instance from the current checkout and
   exercise actual workspace bundle activation and interactive rendered panels.
7. Work through the acceptance checklist in `docs/ios-integration-plan.md`,
   adding honest captured evidence. `scripts/cli/mobile-smoke.mjs --platform ios`
   currently **throws "iOS end-to-end smoke is unsupported"**. The current
   runner uses Android UI automation, logcat, and CDP throughout; simply removing
   that guard or checking launch would not provide equivalent coverage.
8. Re-run focused checks justified by subsequent changes. External Base/Personal/
   System template checkouts are source inputs: use this repository's host-owned
   `test:userland` / `type-check:userland` projections, never tooling with those
   external checkouts as its working directory.
9. Physical-device signing, camera QR pairing, OAuth callbacks, Wi-Fi/cellular
   transitions, APNs/Firebase push, associated domains, signed archives, and
   TestFlight remain to be configured and tested. The user has not yet supplied
   a physical iPhone, developer-team details, or Firebase/APNs credentials.
   Ask only when those block the corresponding work; continue independent work.

## Concurrent work and scope

The shared checkout contains substantial unrelated staged and unstaged work
in desktop/headless browser hosting, credential storage, CDP, view management,
and e2e tests. Other work changed during this session. **Do not reset, unstage,
overwrite, or commit those changes as part of this task.** No commit or PR was
created by this agent.

This task's changes are the iOS files, mobile installer/helper/tests,
integration documentation, React Native fmt dependency patch, and the related
root package/lockfile entries described above. Review current diffs rather than
assuming all dirty files belong to this task.

The simulator-download process was deliberately left running at the user's
explicit request. An attempted permission request to inspect its PID was
rejected; no process-inspection or termination workaround was attempted.

## Continuation checkpoint: 2026-09-30

The previous preparation processes completed. CocoaPods resolves fmt 12.1.0;
Release builds now compile and link with the bundled Hermes bootstrap. Native
repairs cover the launch storyboard runtime, Swift throwing connection close,
Objective-C++ identifiers/data pointers, the WebView subclass interface, and
AuthenticationServices linkage. The installer reconciles Pods on each build.

Xcode 27 requires UIKit scenes. App startup now uses SceneDelegate and the React
Native factory, with cold and warm links routed through the native lifecycle.
The scene build passed (`/tmp/vibestudio-ios-release-scenes-20260930.log`), but
runtime launch exposed Firebase Messaging 23.8.8 reading the legacy app-delegate
window selector. The Messaging dependency patch now uses connected scene windows and scene
foreground notifications. The Release rebuild passed
(`/tmp/vibestudio-ios-release-messaging-arm64-20260930.log`); the app stayed open
and visibly rendered the pairing screen without Metro. That screen reported a
missing entitlement: the unsigned simulator build could not access Keychain.
Simulator signing is being corrected to local ad hoc signing; the global
`CODE_SIGN_ENTITLEMENTS` installer override was removed because it incorrectly
applied the app's entitlement file to CocoaPods dependency targets. The app
target already declares that file. Signing then exposed an entitlement-generation
cycle inside the app target. Entitlements are now generated before build planning
by a pre-action on the checked-in shared `Vibestudio` scheme; no target modifies
signing inputs while building. The CLI uses the same scheme instead of calling
the generator separately. The signed Release build succeeded and installed
(`/tmp/vibestudio-ios-release-signed-scheme-20260930.log`); Xcode emitted
`FAKETEAMID.app.vibestudio.mobile` in simulator entitlements. Signature verification
passed. Runtime then exposed React Native's remaining app-delegate window access
in `RCTDeviceInfo.interfaceOrientationDidChange`; the crash report is
`Vibestudio-2026-09-30-011349.ips`. The existing RN patch now also makes orientation,
safe-area fallback, and debug overlay window restoration scene-aware. That
runtime repair is installed but not yet rebuilt or verified. Successful
Keychain identity creation, pairing, and workspace activation remain unverified.

Process audit at the user's request found no lingering native build/preparation
commands. The booted simulator had 222 processes (~889 MiB resident); the isolated
test server had 16 (~138 MiB), including one unreaped child. The owned simulator
`2E2862EF-43D4-432B-A483-9807C3F0C6E8` was shut down, and ephemeral server
`iphone-20260930-0020` was stopped and awaited. All tracked descendants, including
the zombie, disappeared; its temporary instance directory was removed. The
server had one unreaped child in the captured snapshot; its duration and origin
were not measured, so this does not establish a persistent process leak. No unrelated
server or test process was stopped. Computer-use permissions are granted.

The normal installer is now rebuilding after the React Native scene-window
repair (`/tmp/vibestudio-ios-install-signed-scenes-20260930.log`). Its Release
configuration builds both simulator architectures even with a concrete UDID;
the previously signed executable was confirmed universal (x86_64 + arm64).
Do not describe those builds as arm64-only. No Metro or isolated server is
running; the owned simulator is booted for this installer run.

### Latest runtime and process checkpoint

The normal signed Release installer completed with exit zero
(`/tmp/vibestudio-ios-install-signed-scenes-20260930.log`). The pairing screen
rendered without Metro or a Keychain entitlement error, survived rotation, and
survived background/foreground transitions after the React Native scene repairs.
Pairing and workspace activation are still unverified. Opening a pairing link
while the bootstrap is running reloads React Native and loses the pending request:
AppDelegate forwards the URL immediately and schedules a bootstrap reload. Fix
that lifecycle route rather than treating cold-launch-only testing as acceptance.
A cold-launch link was delivered next; its UI result still needs inspection.

An isolated ephemeral server `iphone-20260930-0136` is intentionally running for
pairing tests (owned terminal session 4782, process-tree root 47296). Its private
log is `/tmp/vibestudio-iphone-server-20260930-0136.log`. The owned simulator
`2E2862EF-43D4-432B-A483-9807C3F0C6E8` is booted, with simulator launchd PID 36356.
The latest audit found 11 server processes and 202 simulator processes, no zombies
and no native build/preparation processes. These counts describe active test
resources, not evidence of a leak. Stop and await the owned server and shut down
this exact simulator when testing finishes; verify descendants and ephemeral
instance state are removed. Do not stop unrelated desktop/e2e process trees.
The private pairing invite is in `/tmp/vibestudio-iphone-pair-20260930-0136.json`;
it expires after ten minutes. Do not publish its credential-bearing contents.

### Publication checkpoint

The owned server `iphone-20260930-0136` was interrupted and awaited, and the exact
owned simulator was shut down before committing this checkpoint. No Metro or
native build/preparation process remains owned by this task. Temporary pairing
credentials remain outside the repository. Implementation and documentation are
being committed separately; this publication does not establish end-to-end
iPhone acceptance.

### Warm-link fix checkpoint

The signed Release native rebuild and normal install/launch succeeded using
`/tmp/vibestudio-ios-warm-link-fix-20260930.log`. SceneDelegate now passes warm
pairing links as standard launch options when replacing the React Native runtime;
AppDelegate releases the outgoing root/factory and invalidates a legacy bridge.
A link opened while the app was running visibly reached Connect this device?
with Pair/Cancel. The earlier warm-link defect is repaired at the review-screen
boundary; actual pairing and workspace activation remain to be verified.

The new owned ephemeral test server is `iphone-20260930-0210` (terminal session
35181), with root
`/var/folders/yg/ggxmwbzx3jxgs3xrp8wkh44m0000gp/T/vibestudio-iphone-20260930-0210-uCG8bK`.
Its log is `/tmp/vibestudio-iphone-server-20260930-0210.log`, and the same owned
simulator is booted. A private, unconsumed invite exists in
`/tmp/vibestudio-iphone-pair-20260930-0210.json`. The user approved pairing this simulator with the test server, and Pair was
clicked. The app now shows Connecting securely to your workspace; inspect the
result and continue activation/recovery tests.

Physical-phone and distribution credentials are unavailable, as confirmed by
the user. They are open to workable deployment approaches, prefer workspace
guidance, and accept TestFlight's 90-day expiry. Reuse the existing desktop phone
provisioning service and System-owned phone setup flow, rather than creating
a second installer. Reviewed distribution needs a separate assessment of the
streamed executable bundle design against Apple's review requirements.

### Pairing, Debug installation, and workspace provisioning checkpoint

The invitation for `iphone-20260930-0210` referred to a server that had already
exited and whose temporary root was gone when Pair was clicked. The resulting
connection failure does not establish an iOS Iroh transport defect. A fresh,
owned ephemeral instance `iphone-20260930-0220` stayed live, and pairing reached
**Start this workspace?** for the System template. Credential creation and the
pairing handshake therefore passed. Workspace activation was not clicked or
verified before native-window access became unavailable.

The first Debug build succeeded, but installation looked for
`Debug-iphoneos/Vibestudio.app` after Xcode built `Debug-iphonesimulator`: an
explicit simulator UDID incorrectly selected the physical SDK/product path.
The SDK and destination now come from one build-target calculation, and artifact
selection uses that same SDK. The normal installer rerun exited zero; the Debug
app launched and connected to Metro. Evidence is in
`/tmp/vibestudio-ios-debug-install-20260930.log` and
`/tmp/vibestudio-iphone-metro-20260930.log`. `mobile dev` now forwards a selected
simulator UDID instead of ignoring it. Published in `850aa89ea`.

The desktop workspace phone setup service now forwards the discovered simulator
kind to the existing installer. Discovery shares the installer's iOS-only,
available simulator filter. Physical discovery uses CoreDevice JSON with the
current Xcode 27 `properties` schema, excludes Macs and simulated entries, and
requires a paired connection before declaring a phone ready. Actual discovery
succeeded without duplicating the booted simulator as a physical phone.
Published in `3ffeb838e`. Ten provisioning tests passed, including detached
native cancellation; ten iOS helper tests passed. Physical discovery remains
fixture-tested only. Full commit checks passed for both commits.

The bootstrap now highlights Pair when no launch session exists and removes a
duplicate pairing instruction. Metro served this updated source, but visual
verification of that small layout change is still pending.

Computer Use returned `cgWindowNotFound` for both Device Hub and Xcode, although
the simulator remained booted and its app connected to Metro. Rebinding the apps
and checking the native-window inventory did not restore access. Do not replace
interactive acceptance with CLI launch evidence, or bypass the UI through a
second automation mechanism. Resume at workspace trust review once native
windows are accessible, then test bundle streaming, rendered panels, messages,
stored-credential restoration, reconnect, and permission/lifecycle recovery.

All 17 tracked server, Metro, and app processes retired; none was a zombie in
the pre-stop snapshot. The exact owned simulator was shut down. The server's
interrupt shutdown logged repeated SIGINT/SIGTERM and `kill EPERM` from the IPC
owner-loss handler; its processes exited but its ephemeral root remained. After
checking the exact registry record, ephemeral ownership, and dead supervisor,
the root was removed through `removeEphemeralInstanceRoot` and its registry entry
unregistered. This is an observed shutdown/state-retirement defect, not evidence
of a surviving process leak. Investigate the signal/ownership lifecycle before
claiming automatic cleanup works for this launch route. No unrelated instance
or process was stopped.

Additional deployment gaps remain: iOS discovery still does not report installed
apps or their compatibility; the current native marketing version is 0.1.0 while
the desktop is 0.1.52. Derive a coherent native compatibility/version contract
before allowing setup to skip installation. Simulator doctor checks still ask
for physical signing. Physical-device signing, OAuth/notification behavior,
APNs credentials, and actual TestFlight distribution need the unavailable phone
and Apple/Firebase accounts. TestFlight's 90-day expiry is accepted, but review
eligibility for executable workspace bundles must be resolved before relying on
that route. Continue through the existing System phone setup extension and
desktop provisioning service; do not create another installer.

### Source repairs and native lifetime verification: 2026-09-30

This checkpoint supersedes the source gaps in the preceding checkpoint.

- `f1b56d1e9`: Root SemVer now generates the app-only numeric iOS marketing
  version, checked at commit time. CoreDevice discovery includes installed apps,
  applies the existing shared compatibility contract, and respects the configured
  bundle ID. Workspace setup reuses a compatible installed iPhone shell without
  requiring native sources and checks compatibility after installation. Simulator
  doctor excludes physical signing; APNs checks use the entitlements generator's
  actual environment input. The normal Debug installer and actual simulator
  discovery reported version 0.1.52, compatible, with no issues. Twenty-two CLI
  tests and eleven provisioning tests passed.
- `f03a1804a`: The developer supervisor owns signals through child retirement and
  ephemeral state cleanup. Repeated signals coalesce into one retirement;
  competing Hub force-stop signaling was removed. Lifecycle entry points run
  directly under Node's TS loader, avoiding an outer CLI wrapper that could exit
  before cleanup. A regression failed before the fix and passed afterward. The
  actual `iphone-shutdown-20260930-0810` CLI launch stopped with exit zero: all
  eight tracked processes retired, the ephemeral root disappeared automatically,
  and no `EPERM` occurred. Seventeen focused ownership tests passed; one
  platform-specific test was skipped.
- `c729c6a97`: Iroh implements native runtime invalidation. It closes owned
  connections/endpoints, rejects late resources from a retired runtime, and
  preserves persistent Keychain identities. The app-hosted native test target
  proves a pending accept ends, the retired module is released, and a replacement
  runtime rebinds the identity. Both tests passed on the owned iPhone 18 Pro,
  iOS 27 simulator using normal ad hoc signing. Private evidence:
  `/tmp/vibestudio-ios-native-lifecycle-20260930-0810.log` and `.xcresult`.

Full commit checks passed for these commits, including host types/lint,
version metadata, source boundaries, and external template hygiene. This task changed only the
host repository; it did not edit the configured template repositories.
Native unit execution does not establish streamed workspace acceptance.

Native-window access briefly recovered and exposed the System workspace review,
including Start/Quit. Activating System declares saved-account, workspace-data,
and host-command access. The specific Start confirmation remains pending under
Computer Use's action-time confirmation rule for material access grants; general
autonomy does not satisfy that tool rule. No Start click has been made. A later
rebind again returned `cgWindowNotFound`, and the inventory listed running apps
without accessible windows. The cause is not established; do not claim that
Accessibility permissions were absent or that source work was blocked by it.

### Expanded native resource coverage and CI verification

Published in `5a65b5fca` (native resource ownership) and `707577a17` (CI).

The mobile host now uses one serial resource queue, including document-picker
callbacks, and retires its bundle/asset streams, owned temporary archives, and
picker promises when React Native invalidates it. Cleanup touches owned staging
files only; committed bundles and durable stores survive. OAuth invalidation
cancels the session and timer, rejects its pending promise once, and refuses new
starts. Completion callbacks belong to the session that created them.

All five app-hosted native XCTest cases passed on the same iPhone 18 Pro/iOS 27
simulator. Evidence is `/tmp/vibestudio-ios-runtime-resources-fixed-20260930.log`
and `.xcresult`. The initial expanded test build failed because its new Objective-C
tests needed AuthenticationServices linked in the test target; that target
metadata was repaired and the normal command rerun successfully. Three focused
host Iroh contract tests passed. Native tests used no UI automation and do not
establish real OAuth/browser or streamed workspace acceptance.

The CI iOS build now uses a generic simulator destination with normal ad hoc
signing through the shared scheme, rather than a fixed iPhone model, disabled
signing, and global app-entitlement injection. It checks generated version
metadata and covers native tooling changes in PR path filters. The exact command
built successfully for both arm64 and x86_64; evidence is
`/tmp/vibestudio-ios-ci-generic-20260930.log`.

The owned `iphone-20260930-0725` server was stopped through its exact supervisor
and awaited with exit zero. All eight tracked processes are gone and its
registered ephemeral root disappeared automatically. Metro and both console
launch sessions exited zero. All native builds/tests completed, and simulator
`2E2862EF-43D4-432B-A483-9807C3F0C6E8` was shut down. No task-owned server,
Metro, app, or native build is intentionally left running. No unrelated process
was stopped. Continuation needs a new isolated server and fresh invite; do not
reuse invitations for the retired instance.

The unresolved work is explicit: restore native-window capture and obtain the
pending workspace Start confirmation, then exercise streamed activation, rendered
panels, agent messages, layout/keyboard behavior, stored state, warm links from a
loaded workspace, reconnect and failure recovery. `mobile smoke --platform ios`
remains unsupported. Physical signing, camera/permissions, real OAuth/APNs,
associated-domain delivery, and TestFlight installation need the unavailable
phone and accounts. The integration plan records the reviewed distribution
architecture assessment; no beta URL or release approval exists.

### Interactive continuation and native rendering repairs: 2026-09-30

The user disabled screen lock for four hours and explicitly approved Start for
System on `iphone-20260930-0918`. Native screenshots and interaction became
available through Device Hub. That supports a screen/session-state explanation
for the earlier capture failure, without establishing screen lock as its sole
cause. Routine Computer Use is authorized; the recorded System grant is no
longer pending.

Published changes:

- `d462dd678`: review rows preserve canonical `InstallReviewPart.identityKey`,
  avoiding duplicate React keys for a worker and extension both named
  `local-models`. All 28 launch-gate tests passed. `mobile logs --platform ios
--device <simulator-udid>` now selects that exact booted simulator.
- `ffc909f99`: provider input leases live at the declared workspace
  `build-provider-inputs` anchor, admitted read-only to the native runtime.
  The previous `.provider-inputs` directory lived among immutable build records;
  GC classified it as an unreconstructible build and refused its epoch commit.
  No collector name exception was added. All 13 focused provider/runtime/app
  build/layout tests passed, including live-input inventory separation,
  read-only isolation, source/cache denial, and lease cleanup.
- `62aa9238c`: React Native’s scene root owns status-bar style/visibility and
  animations; the app keeps controller-based appearance. This fixes the legacy
  status-bar red box without an Info.plist bypass. WebView now routes only
  actual file URLs through `loadFileURL`; `about:blank` previously crashed
  streamed activation. Blank/data/HTTPS/panel schemes use normal requests.
  Existing versioned patches and their locked hashes own both changes.

All eight app-hosted native tests passed against the patched Debug native host:
`/tmp/vibestudio-ios-native-eight-20260930.log` and
`/tmp/vibestudio-ios-native-eight-20260930.xcresult`. These tests cover Iroh,
OAuth, transient file cleanup, scene appearance, and WebKit loader selection.
They do not establish interactive panel, message, or recovery acceptance.

The app then reached its managed login route, restored its credential, and
connected to System and Personal, but froze on “Opening your workspaces…”.
A two-second native sample captured the same wait on every sample: the main
animation thread awaited the descriptor-registry shared lock; JavaScript held
that registry’s exclusive lock while synchronously waiting for UIKit to
initialize a legacy view manager. The private evidence is
`/tmp/vibestudio-iphone-loading-sample-20260930.txt`. This matches
[React Native issue 53128](https://github.com/react/react-native/issues/53128).
The repair constructs the descriptor outside the inventory lock and locks only
publication. The concurrent-reader regression and all eight existing native cases passed
after reboot. Published as `7ea12683d`, including the dependency patch hash.

### Machine restart recovery: 2026-09-30

The machine restart terminated the previous ephemeral server, Metro, log stream,
app, and build processes. Its ephemeral root was gone; its stale registry entry
was removed after verifying ownership and process absence. The old `/tmp`
evidence paths above no longer exist; the observations remain historical.

The simulator runtime asset survived but its registration and discovery helpers
retained stale mount paths. Re-registering the preserved Apple runtime asset and
refreshing the idle discovery services restored the original simulator without
clearing its app data. The native build-for-testing succeeded, then all nine
app-hosted native tests passed with zero failures. Private evidence now survives
reboots under `~/.config/vibestudio/iphone-verification/20260930-reboot/`:
`registry-build-rerun.log`, `native-nine-retry.log`, and
`native-nine-retry.xcresult`. The first post-reboot test launch was canceled and
awaited; the retry completed successfully after discovery recovery.

Continuation uses the separately owned persistent instance
`iphone-20260930-reboot`, Metro, the original simulator, and a temporary
`caffeinate` helper. Persistent state permits an actual stop/restart reconnect
check, unlike destroying an ephemeral root. The app has launched; interactive
acceptance is pending. Stop and await these exact resources at verification end.
Do not stop the unrelated `authority-preparation-0930` server or user apps.

### Approval accessibility and presentation continuation

The patched native host streamed and ran the managed System app, authenticated,
started its panel facade, reconciled System and Personal, and advanced past the
previous loading freeze to Personal's onboarding review. A fresh native sample
shows the main and JavaScript threads waiting in their ordinary run loops,
not the old registry/UIKit lock inversion.

Published System changes:

- `9d3de21`: the approval sheet is a modal container that preserves individual
  accessibility children; its title is a heading. The earlier accessible summary
  swallowed fields, filters, dismissal, and decision controls on iOS. All 49
  ApprovalSheet tests and the composed System typecheck passed. On the refreshed
  simulator the heading, search field, filters, part checkboxes, dismiss button,
  and decision button are now separately exposed.
- `6de53eb`: the workspace approval surface honors the shared queue's open state.
  Closing deliberately retains selection for reopening; rendering from selection
  alone left the sheet visible after dismissal. All five surface tests passed,
  including disappearance without a decision and reopening the same request.
  Native confirmation of dismissal is pending the fresh server's mobile build.

Published host CI change `1d118f7ec` runs native XCTest on an owned simulator
created from an available runtime/device-type pair, cleans it with an EXIT trap,
and uploads its result. YAML parsing, shell syntax, and an actual local
create/delete metadata check passed. Hosted CI has not been observed yet.
This does not implement full iOS workspace smoke.

The ordinary Vitest userland route excludes React Native UI tests; its attempted
focused invocation correctly found no tests. Verification instead used the
existing host-owned `pnpm test:mobile` Jest dependency projection, with no build
or package-manager invocation inside the external System checkout.

The stopped `iphone-20260930-reboot` and `iphone-20260930-accessibility` servers
were signaled and awaited with exit zero. The current owned persistent server
is `iphone-20260930-visibility`; Metro, simulator, native log stream, and awake
helper remain owned for continuation. Private logs stay in the persistent
verification folder above. No Personal onboarding grant was accepted during
these checks. Dismiss its review and verify the already-approved System UI.

## Live workspace and layout checkpoint — 2026-09-30, 13:10 Berlin

Published native fixes after reboot:

- Root `8edac9bdf`: cache misses and picker cancellation return JavaScript `null`
  through the native bridge. Returning Objective-C `nil` produced `undefined`
  and broke asset lookup with HTTP 502. Eleven app-hosted native tests passed.
- Root `8ec386b28`: the custom WebView delegates React Native's message handler
  to its superclass and installs workspace adapters before dependent startup
  scripts. WebKit's user-script collection is live; even `copy` aliases it, so
  script reordering now materializes an owned Foundation array before removal.
  Actual native WebKit tests verify first-document callbacks and prop changes,
  plus malformed/null/string notification arguments. Twelve tests passed in the
  earlier full run; the remaining case and the second new case passed together
  after the ownership fix. Do not call this one full green 13-test run.
- System `bd6ad2c`: shared AppModal applies the host's portrait and two landscape
  orientations to all native overlays. The original sideways approval sheet was
  reproduced through Computer Use. Seventy-six sheet tests passed across the
  initial run and a focused retry; two initial timeouts coincided with competing
  host builds. Twenty-one additional privacy/create/transfer tests passed.
- System `c4b7114`: MainScreen owns iOS keyboard avoidance, reducing the native
  WebView viewport rather than adding a panel offset or hiding WebKit's form
  accessory. The original accessory/composer overlap was reproduced. Both System
  composition and mobile typechecks passed for both source changes.

Actual native UI acceptance on `iphone-20260930-visibility`:

- New Panel rendered, navigation opened Agentic Chat, the software keyboard
  accepted a prompt, and Send submitted it after dismissing the keyboard.
- The user specifically authorized a one-use ChatGPT credential grant. Credential
  lookup and the subsequent fetch each required approval. Accepting both promptly
  delivered the visible reply **iPhone verification complete.** Accepting only
  the lookup left the model stream waiting for fetch authority; the 60-second
  progress timeout retried and requested approval again. This is a remaining
  admission-flow gap, not evidence of an unavailable provider.
- Cold launch restored the saved device credential and System selection. A
  persistent-server stop and restart recovered the same conversation and reply.
  Debug mode showed a fatal error overlay for a recoverable RPC publication
  failure during the outage. The client already republishes on connection/recovery;
  its diagnostic is being changed to a warning and 54 RPC client tests passed.
- Native approval dismissal was verified earlier; it is no longer an open UI gap.

A fresh ephemeral `iphone-20260930-layout` instance now owns live verification
of the new System snapshot. The previous persistent instance was stopped and
awaited successfully. Direct template-update preparation on the previous fixture
reported no recorded exact source, so no installed workspace files were edited
behind the semantic import boundary. The fresh fixture uses normal bootstrap and
System review. Its native bundle activation is still in progress at this checkpoint.

Hosted CI run `36706691764` was manually dispatched on main to exercise the iOS
job. Recent successful push runs skipped iOS; their overall green status is not
native CI evidence. This dispatched run must still be inspected. Physical camera,
APNs, associated-domain/OAuth redirects, signed distribution, and App Store policy
acceptance remain external checks. Simulator keyboard/rotation, cookie isolation,
and invalid/expired invite acceptance are still evidence gaps unless a later
checkpoint records actual results.

Private logs/results are under
`~/.config/vibestudio/iphone-verification/20260930-reboot` with restrictive access.
They contain account identifiers and pairing links; do not publish their contents.
The older stopped reboot/accessibility instance roots were removed after ownership
checks. Final cleanup of the current layout fixture, Metro, native log stream,
caffeinate, simulator, publication worktrees, and visibility state remains required.

## Panel geometry and touch layout checkpoint — 2026-09-30, 14:30 Berlin

The rectangular native safe-area boundary was the wrong presentation design.
It exposed the host background as a bottom strip and forced every panel into a
smaller rectangle. The user explicitly rejected it. The replacement keeps the
panel canvas edge to edge: the display clips content at its physical curves,
and panels decide whether their controls need safe spacing. No global padding,
artificial screen mask, or native safety bar is applied to panel documents.

Published source:

- System `f455217` removes the native panel safe-area frame and uses iOS keyboard
  avoidance with padding against the current flex frame. Native headers retain
  their own safe controls. Modal backdrops cover the window; sheet contents and
  action rows own their spacing instead of duplicating a bottom safe frame.
- System `f0b9871` measures each panel slot in window coordinates and intersects
  it with the window's safe rectangle. Optional `--vibestudio-safe-area-inset-*`
  CSS values and a best-effort corner hint are published on the document root.
  Geometry is bounded by the actual panel frame, so a header or keyboard that
  already excludes an edge does not receive another inset. Asynchronous
  measurements are guarded by epoch and document ownership; equal geometry
  and CSS properties do no work. Publication creates no React state updates or
  DOM resize observers. The hint is approximate, not a private display-radius API.
- Base `c399c9f` gives touch composers an eight-pixel gap, coordinates the outer
  card and inner editor curves, and improves agent settings: remaining-space
  scrolling, an accessible Advanced button, a full-width Reactiveness selector,
  labeled checkbox rows, forgiving effort controls, and no-zoom touch input text.
- Base `f19b28a` defines the canonical optional geometry properties with browser
  `env()` defaults. Chat explicitly consumes them; other panels opt in as needed.

For panel authors: keep the canvas/scroll viewport full size and paint its own
background through the edges. Put any safe space into scroll content or fixed
controls, not a wrapper around the whole viewport. A surface adjacent to an edge
can derive its radius from the shared hint minus its own edge spacing; an inset
editor subtracts the next gap again. These values hint appearance and placement;
they do not impose a clipping or padding policy on panels.

Evidence:

- Hosted workflow [36706691764](https://github.com/panticonic/vibestudio/actions/runs/36706691764)
  completed successfully: iOS Debug simulator build, **all 13 native tests in one
  run**, and native evidence upload passed. Android also built successfully. This
  supersedes the earlier pending dispatch and 11-plus-focused-case evidence.
- Nine focused mobile suites passed all 106 cases after removing the strip.
  Existing WebView lifecycle/bridge/retention cases passed; four new geometry
  cases passed for header, keyboard, landscape, and optional/no-repeat CSS
  publication. System composition and mobile typechecks passed.
- Focused Base input, settings, setup, message-area, and layout tests passed,
  along with the Base composition typecheck. Template checkout hygiene passed.
- Before the replacement, cold portrait keyboard use stayed stable while a
  landscape-to-portrait path produced a blank panel with repeated WebKit layout
  and roughly 120% app CPU. RN's height-mode keyboard boundary retains its first
  frame height; the final source uses padding. This is evidence for an obsolete
  frame/resize problem, not proof that ordinary React rerenders caused the user's
  flicker. Final rotated-keyboard acceptance must be recorded separately.
- The edge-to-edge simulator snapshot showed the panel background continuing
  through the physical bottom corners, without a host-colored strip. Its
  embedded browser safe-area values were insufficient for the composer; the
  optional measured geometry contract addresses that remaining placement gap.

`iphone-20260930-layout`, `iphone-20260930-insets`, and `iphone-20260930-edges`
were stopped and awaited. The current owned ephemeral fixture is
`iphone-20260930-geometry`; its final native bundle is activating. Metro,
native log streaming, caffeinate, the simulator, old visibility state, and
publication worktrees still require final cleanup. Do not claim combined visual
acceptance or cleanup complete until a later checkpoint records their results.

## Directional screen-corner checkpoint — 2026-09-30, 14:55 Berlin

The user clarified that only component corners facing physical display corners
should inherit a large curve. The prior live scalar-hint snapshot still rounded
all four composer corners; publishing source alone did not update that fixture.

- System `d8475d1` publishes four independent corner hints. A corner is exposed
  only when both adjoining panel edges coincide with the window edges. Native
  headers exclude top corners; keyboard-shortened frames exclude bottom corners;
  inset and split slots receive only their actually exposed corners. The radius
  remains an approximate appearance hint, with no host padding or clipping.
- Base `f49920d` uses only the bottom-left and bottom-right hints for the composer
  and its inset editor. Top corners keep their usual small radius. Card paint
  follows the same directional border shape. The agent setup card now owns its
  internal padding rather than inheriting the zero-padding transcript surface.
- Five directional geometry tests and 22 ChatInput/ChatLayout tests passed.
  System/mobile and Base composition typechecks and checkout hygiene passed.

The old `iphone-20260930-geometry` fixture was stopped and awaited. The fresh
owned `iphone-20260930-corners` fixture is building the current published source
through normal template bootstrap. No installed workspace files were patched.
Final simulator acceptance and process cleanup are recorded below when complete.

A separate Debug reload defect surfaced while reconnecting Metro at 14:52:
`RCTMountingManager attachSurfaceToView:surfaceId:` aborted because the target
view already contained subviews. The private crash report and native log identify
this assertion; they do not establish its lifecycle root cause. Do not describe
this as the earlier layout-flicker cause or as a fixed defect. The hosted native
suite passes, but did not exercise this long-lived Debug/Metro reload sequence.

### Native directional-corner acceptance — 2026-09-30, 15:03 Berlin

The fresh `iphone-20260930-corners` workspace activated the current System and
Base source. Computer Use verified the actual iPhone simulator UI:

- The composer has small ordinary top corners and larger bottom corners,
  rather than the earlier four-corner pill. Its panel background continues
  through the physical bottom corners without a separate host safety strip.
- Focusing the composer and entering the unsent draft `Corner layout check`
  brought up the software keyboard. The input stayed fully visible in portrait,
  with ordinary bottom curves at the flat keyboard boundary.
- Rotating with the keyboard open and returning to portrait preserved that
  draft and the visible input. The earlier blank-panel/high-CPU layout failure
  did not reproduce on this path. Bounded idle observations showed roughly
  4–8% app CPU, rather than the earlier approximately 120% loop; this is not a
  broad performance certification or proof against every flicker report.
- Touch scrolling reached Advanced and Save workspace defaults in the settings
  form. Advanced expanded to a full-width Autonomy selector without horizontal
  clipping. The settings card's labels and controls have internal padding.

Landscape with the software keyboard still partly covers the composer with
WKWebView's native input accessory toolbar. That compact-height layout gap is
not fixed by the directional radius change. Do not claim landscape keyboard
acceptance passed. The independent Debug reload assertion above also remains
open. No new model prompt or account-access grant was accepted for these checks.

Keyboard capture was restored to off. Metro was stopped and awaited; temporary
publication worktrees were removed; the retired owned visibility instance state
was removed with the sealed-tree cleanup helper after checking ownership and
absence of running processes. The final ephemeral server, native log stream and
caffeinate were stopped and awaited, and the owned simulator was shut down.
