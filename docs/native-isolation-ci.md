# Native isolation acceptance

The `CI` workflow tests native workspace execution on Linux x64/ARM64, macOS
14 and 26 (Apple Silicon), and Windows Server 2025 x64. Linux/macOS run through
stock MXC; Windows deliberately runs as the app's normal account, without OS
filesystem, network, clipboard, or process isolation. Windows is not a sandbox
fallback selected after failure: it is the explicit platform contract.

Every platform tests interactive PTYs, process lifecycle/restart, dependency
installation, cleanup, private runtime environments, and both directions of
localhost networking. Unix additionally tests filesystem denial, read-only
resources, offline utility jobs, and adversarial cleanup races. Windows tests
positively verify host-file access and ordinary networking; those tests must not
be presented as proof of containment. Workspace code on Windows can access files
and credentials available to the account, even though secret environment
variables are not automatically copied into commands.

No Windows administrator setup, AppContainer profiles, host ACL mutations, or
loopback exemptions are required. The existing application egress proxy remains
separate and retains its permission and filtering behavior on all platforms.

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
credential extraction and profile retirement under the platform execution policy. Host tests also check session
ownership, connection loss, startup failure, and cleanup retries. Paid-provider
authentication is outside this CI suite. Linked execution requires Claude Code
2.1.139 or newer: hooks invoke the installed Vibestudio CLI with direct argument
arrays, without depending on a global CLI installation or platform shell quoting.

Windows also runs the native suite as a temporary standard user. This matters
because GitHub's Windows hosted runner normally runs with administrative rights.
The account runner verifies the child identity and token, uses that user's profile
and temporary directory, and retires its processes, account and profile afterward.
Its checkout permission is for the temporary developer account; the application
does not alter sandbox ACLs.

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
and the platform native runtime payload. It exercises provider-independent startup and workspace
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
Windows networking failures are product compatibility failures, just as they are
on Unix; host execution must preserve normal developer networking.

## macOS device access

macOS workspace commands have recursive read/write access to `/dev`, subject to
the account's ordinary OS permissions. This intentionally includes accessible
serial and other device nodes, not only terminals. It does not grant elevated
permissions. Ordinary filesystem access remains governed by workspace grants.

[`node-pty`'s spawn helper](https://github.com/microsoft/node-pty/blob/v1.1.0/src/unix/spawn-helper.cc)
uses `ttyname()` before attaching the terminal; Apple's libc enumerates `/dev`
while resolving the device name. MXC's terminal policy alone does not allow that
enumeration, and a read-only `/dev` grant overrides terminal write permissions.
The explicit read/write device grant accommodates both operations. Native CI
still verifies controlling-terminal attachment, input/output, and resize.

## Native runtime compatibility

Workspace utilities and npm installations use the pinned stock Node distribution
shipped with the application, not Electron's Node compatibility mode or a Node
installation discovered on the host. Build and package verification check the
official archive digest and the complete extracted inventory. Electron and
standalone server packages retain upstream npm files and relative executable
symlinks. Extension dependency cache identity includes this Node version.

Npm lifecycle scripts use the same platform execution policy, with a private
home/cache and an explicit environment. Unix restricts writes to the installation
and private state; Windows has account-level host access. Ambient host npm
profiles, registry tokens and Node options are not inherited. Authenticated
private registries require an explicit credential interface for this install
path; this environment hygiene does not prevent Windows code reading host files.

On macOS, CoreFoundation's installed Electron startup performs libc account
lookup. The Seatbelt policy allows the `com.apple.system.opendirectoryd.libinfo`
Mach service for that operation, without enabling MXC's keychain access.

Workspace server shutdown waits for its owned child to exit and attempts process-
group cleanup. Descendant termination remains best effort: children can create
new sessions, and a macOS group containing only zombies can return `EPERM`.
Cleanup diagnostics do not claim proof of termination or prevent an otherwise
orderly shutdown or workspace restart.
