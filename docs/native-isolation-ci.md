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

Windows also runs the native suite as a temporary standard user. This matters
because GitHub's Windows hosted runner normally runs with administrative rights.
The account runner verifies the child identity and token, uses that user's profile
and temporary directory, and retires its processes, account and profile afterward.
Its host checkout permission is for the temporary developer account; it does not
change the MXC AppContainer policy.

The macOS and Windows jobs also run the existing desktop pairing smoke against
a fresh Base checkout, covering connection approval, panels, relaunch and recovery.
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
