# Native isolation acceptance

The `CI` workflow runs real MXC processes on Linux x64/ARM64, macOS 14 and 26
(Apple Silicon), and Windows Server 2025 (x64). It builds the production host on
each platform. Missing executors or unavailable sandbox facilities fail these
jobs; mocked configuration tests alone cannot satisfy the gate.

The native suite covers filesystem denial, workspace sharing, interactive PTYs,
process lifetime and restart, concurrent owners, offline trash deletion, symlink
and directory replacement attacks, and Windows ACL restoration. Normal workspace
networking must connect to a host loopback server and expose a development server
to the host. Windows connectivity errors are failures, including errors caused by
AppContainer restrictions. CI does not apply firewall changes or loopback
exemptions to make those tests pass. The existing application egress proxy remains
separate and retains its own regression coverage.

The Ubuntu 24.04 quality runner keeps its AppArmor hardening enabled. Ubuntu
restricts unprivileged user namespaces unless the invoking application has an
AppArmor profile granting `userns`; the stock MXC Linux backend needs that
operation while starting its bundled `dist/mxc/linux-x64/lxc-exec`. CI loads a
temporary profile attached only to that exact checkout executable, with
`flags=(unconfined)` and the single `userns` rule, before the production tests.
The profile is discarded with the ephemeral runner. CI does not change the
global `kernel.apparmor_restrict_unprivileged_userns` setting or disable
AppArmor. Other Linux hosts must provide an equivalent narrowly scoped profile
when their AppArmor policy denies MXC's user namespace setup.

Linked Claude regression coverage uses synthetic credentials and real MXC for
credential extraction and profile retirement. Host tests also check session
ownership, connection loss, startup failure, and cleanup retries. Paid-provider
authentication is outside this CI suite. Linked execution requires Claude Code
2.1.139 or newer: hooks invoke the installed Vibestudio CLI with direct argument
arrays, without depending on a global CLI installation or platform shell quoting.

Windows also runs the native suite as a temporary standard user. This matters
because GitHub's Windows hosted runner normally runs with administrative rights.
The account runner verifies the child identity and token, uses that user's profile
and temporary directory, and retires its processes, account and profile afterward.
Its host checkout permission is for the temporary developer account; it does not
change the MXC AppContainer policy.

The macOS and Windows jobs also run the existing desktop pairing smoke against
a fresh, locally named Base checkout, covering connection approval, panels,
relaunch and recovery. Giving an exact commit a local branch preserves the
development bootstrap's explicit checkout ownership contract.
This exercises the application beyond the provider-independent packaged chooser.

## Packaged application gate

CI packages the macOS and Windows application after the production build. Native,
desktop, and installed acceptance report independently, so a native failure does
not hide packaging defects. The required native job still fails and release
publication remains gated on acceptance. A separate
job downloads the application archive, preserving executable bits and framework
symlinks, and runs `scripts/packaged-isolation-smoke.mjs --app PATH`. That job
installs harness dependencies but never builds the application. This distinguishes
installed-resource failures from a source checkout that happens to work.

The smoke uses the installed Electron executable, GUI entry point, server bundle,
and MXC payload. It exercises provider-independent startup and workspace
containment; it does not invoke a paid model or require provider credentials.
The pinned Base release must be accessible for real workspace bootstrap. The
shutdown check requires the actual ephemeral workspace and deletion receipts to
disappear. The advertised workspace may retain its host-owned Iroh endpoint
identity; this is separate from disposable workspace code and state.

On releases, fresh jobs install the actual DMG and NSIS candidates and run the
same acceptance harness. macOS additionally verifies the code signature, stapled
notarization ticket, and Gatekeeper assessment. Publication of each installer
depends on its acceptance job. PR packaging is unsigned; it cannot prove Apple
signing works. The release jobs continue to require the existing `RELEASE_MAC`
and `RELEASE_WINDOWS` repository variables and Apple signing secrets.

## Matched host and Base revisions

The `base-ref` input selects the Base revision for source integration tests. It
defaults to the published `main` branch, matching normal pull-request CI. For
coordinated changes in both repositories, push each to a test branch and supply
the exact Base commit; otherwise CI may combine incompatible dependency contracts
from different development revisions. Packaged acceptance still acquires the
committed product Base release pin, independently of this source-test input.

## Windows 11 and running CI

Use the workflow's `windows-runner` dispatch input to select a configured Windows
11 desktop runner label. The same native, standard-user, and packaged acceptance
jobs then run on that image. For example, after configuring an appropriate runner:

```sh
gh workflow run ci.yml --ref BRANCH -f windows-runner=YOUR_WINDOWS_11_RUNNER_LABEL
```

GitHub documents the available [hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and [larger runner images](https://docs.github.com/en/actions/reference/runners/larger-runners),
including Windows 11 desktop options. Account configuration and billing are separate
from committing this workflow.

The runner must be ephemeral, permit local test-account creation, and have the
usual GitHub runner tooling. Do not run untrusted pull-request code on a persistent
personal computer. No Windows 11 runner was configured when this coverage was
added; the default Windows Server job is not evidence of Windows 11 acceptance.
A runner label that is not provisioned leaves jobs queued; it does not select an
alternative platform automatically.

Passing CI establishes the cases tested on those images. It does not establish
coverage of physical devices, third-party endpoint security, every OS version,
interactive OS permission prompts, or every extension/provider workflow. Native
Windows networking failures indicate a product compatibility issue that must be
resolved or explicitly reconsidered before calling that platform supported.

## macOS device access

The September 6, 2026 hosted macOS run confirmed that a nested `node-pty` child
has terminal input/output but cannot open its controlling terminal (`ENXIO`),
while enumerating `/dev` fails with `EPERM`. Terminal resize therefore fails
acceptance. This is not a scheduling delay: the terminal was never attached.

[`node-pty`'s spawn helper](https://github.com/microsoft/node-pty/blob/v1.1.0/src/unix/spawn-helper.cc)
uses `ttyname()` before attaching the terminal. Apple's
[`devname_r`](https://github.com/apple-oss-distributions/Libc/blob/main/gen/devname.c)
implementation enumerates `/dev` to resolve that name. MXC 0.8.0's stock
[`nestedPty` policy](https://github.com/microsoft/mxc/blob/7dac1a952f0c9ad13f0a4cb089c4e0e8b3e0013a/src/backends/seatbelt/common/src/profile_builder.rs)
permits terminal devices but omits directory enumeration. Its public filesystem
configuration cannot grant enumeration alone: a read grant to `/dev` also grants
device contents. A subsequent hosted run established that `readonlyPaths: ["/dev"]`
also emits a write denial that overrides MXC's normal terminal and null-device
write grants. It therefore does not preserve working terminals. The controlling-
terminal and resize tests remain required; this policy is not accepted as working.
Normal account-level device access or a narrower upstream MXC enumeration rule
must resolve this before macOS acceptance can pass.

## Native runtime compatibility

Workspace utilities and npm installations use the pinned stock Node distribution
shipped with the application, not Electron's Node compatibility mode or a Node
installation discovered on the host. Build and package verification check the
official archive digest and the complete extracted inventory. Electron and
standalone server packages retain upstream npm files and relative executable
symlinks. Extension dependency cache identity includes this Node version.

Npm lifecycle scripts run inside MXC with only their installation tree and
private home/cache directories writable. Native acceptance executes a real
lifecycle script and checks host-file denial and cleanup. Ambient host npm
profiles, registry tokens and Node options are not inherited; authenticated
private registries require an explicit credential interface before they can be
supported by this installation path.

Windows console Node imports USER32. MXC's `ui.disable` enables the Win32k
system-call mitigation and prevents that DLL from initializing (guest exit
`0xC0000142` before JavaScript runs). Windows guests therefore keep UI system
calls available. Stock MXC still applies its job restrictions on clipboard,
external UI handles, global atoms, desktop switching, logoff, and system-setting
changes. It uses the shared `winsta0\\default` desktop; this is not a private
desktop. The requested injection restriction depends on OS support and is not
enforced by MXC on builds older than 26100. Filesystem confinement is unchanged.

On macOS, CoreFoundation's installed Electron startup performs libc account
lookup. The Seatbelt policy allows the `com.apple.system.opendirectoryd.libinfo`
Mach service for that operation, without enabling MXC's keychain access.

Workspace server shutdown waits for its owned child to exit and attempts process-
group cleanup. Descendant termination remains best effort: children can create
new sessions, and a macOS group containing only zombies can return `EPERM`.
Cleanup diagnostics do not claim proof of termination or prevent an otherwise
orderly shutdown or workspace restart.

Windows setup uses the shipped `wxc-host-prep` tool with explicit administrator
approval. Each relevant drive root receives MXC's non-inheriting metadata-only
ACE; this grants neither directory listing nor file-content access. Setup also
prepares the NUL device. MXC documents that Windows resets the NUL policy at
reboot, so installing once is not evidence of working after a reboot. Runtime
errors identify the corresponding preparation command. CI prepares these stock
prerequisites before exercising both the runner account and an actual standard
user, and repeats preparation on the fresh installed-application runner.

The September 6 Windows Server 2025 run demonstrates that these prerequisites
are insufficient: Node's path resolution next fails to read metadata at
`C:\Users`. Stock MXC 0.8.0 exposes recursive filesystem grants and drive-root
preparation, but no metadata-only ancestor grants. Broad user-directory access
is not an acceptable substitute. This remains an upstream compatibility blocker,
and the drive preparation itself took several minutes on the hosted runner.
