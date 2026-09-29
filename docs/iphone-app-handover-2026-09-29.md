# iPhone app handover — 2026-09-29

**Current status (2026-09-30):** Signed Release builds and simulator bootstrap
launch, rotation, and foreground recovery passed. End-to-end pairing remains
unverified, and warm pairing links lose their pending request on reload. Read
the latest checkpoint below for continuation; earlier sections preserve the
original handover.

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
