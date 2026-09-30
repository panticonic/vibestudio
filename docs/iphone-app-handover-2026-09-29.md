# iPhone app handover — 2026-09-29

**Current status (2026-09-30):** Signed Release and Debug simulator installation,
bootstrap launch, Metro connection, and pairing through workspace trust review
passed. The previously recorded version/discovery, simulator doctor, supervisor
shutdown, and Iroh runtime lifetime defects are fixed and published. Native
XCTest verifies Iroh retirement. Streamed workspace activation and recovery
remain unverified: activation confirmation is pending and native window capture
has again returned `cgWindowNotFound`. Physical-device and distribution accounts
are unavailable. Read the latest checkpoint below; earlier sections are historical.

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
