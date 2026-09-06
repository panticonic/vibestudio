# Isolation programme

Status: workspace containment implemented; cross-platform release validation pending (2026-09-06).

The installed application, controller, hub and runtime engines are trusted. We
contain workspace-authored code; we do not attempt to contain a compromised
installed controller. Outer application containment is no longer a requirement.

Vibestudio uses the stock, pinned `@microsoft/mxc-sdk` 0.8.0 as its native
process boundary. MXC owns platform policy generation and enforcement. The
host owns workspace identity, resource selection, approvals, control channels,
and lifecycle records. Vibestudio must not recreate bubblewrap, Seatbelt, or
Windows admission logic beside MXC.

## Accepted design

There is one resident native sandbox per workspace for workspace commands,
shells, builds, tests, and native extensions. Linked Claude provider launches
use their own separate MXC process with a provider-specific policy and
disposable profile. Context IDs and command IDs provide routing and provenance;
they are not native security domains. Cancellation and descendant cleanup are
best effort, and a launcher exit is not evidence that every descendant
stopped.

The supported product targets are Linux x64 and ARM64, macOS ARM64, and
Windows x64. The shipped MXC executor is selected from the installed SDK and
is staged under `dist/mxc/<platform>-<arch>`. The payload and its manifest are validated before npm or Electron packaging.
Vibestudio builds no native sandbox or cleanup executable and requires no Rust
toolchain for this integration.

Ordinary native workspace commands and linked Claude use stock open networking
so package downloads, CLI services and local development connections need no
new sandbox-specific proxy machinery. Internal workspace-trash deletion remains
offline. Linux uses the host network and requires no slirp4netns helper. Windows
uses stock networking capabilities; intrinsic AppContainer host-loopback limits
remain a native validation concern, not a promise of transparent connectivity.
Restrictions on normal commands must not be retained at the expense of expected
workflows without revisiting the design.

The pre-existing egress proxy, its destination checks, approvals, credential
handling and callers remain unchanged. Native command networking does not imply
that all traffic is forced through that proxy. Existing browser origin/CORS
protections and account authentication remain unchanged as well. Full-host
terminals still require fresh approval for their wider filesystem/process access.

MXC is preview software; upstream explicitly cautions that its generated profiles
are not yet security boundaries. We use its resource restrictions without
claiming hardened hostile-code isolation. On macOS the stock baseline permits
host terminal slave devices and some host process metadata; isolation from
unrelated terminals is not promised. Windows uses stock ProcessContainer
selection with leastPrivilege disabled and its native ACL lifecycle. Custom
LPAC, storage SIDs, or stronger rollback guarantees are not requirements. The product does not claim protection from an administrator, a
compromised kernel or driver, another unrestricted process owned by the user,
or all resource exhaustion and side channels. These limits must be visible in
release and security documentation.

## Required boundaries

The host must derive every MXC policy from authenticated workspace ownership,
the exact installed runtime, selected source and scratch roots, explicit
environment and handles, and the live authority decision. Guest labels,
manifests, paths, PIDs, readiness responses, and self-reported sandbox state
are not proof of identity or enforcement.

Workspace A cannot read another workspace's files, controller state, protected
credential stores or broker credentials. Local network endpoints remain
reachable under normal networking; their existing authentication and resource
authorization protect workspace data. Network-level endpoint invisibility is
not a requirement.
Managed source and authority state remain receiver-owned and native read-only;
scratch and generated output are workspace-owned. Semantic import/publication
is the only path into protected managed state. Symlinks, reparse points,
hardlinks, traversal, case aliases, and check/use races require explicit
tests at every direct-resource receiver.

The environment is default-deny. Do not inherit host home directories, shell
startup files, SSH agents, package-manager credentials, arbitrary API keys,
or ambient IPC handles. Native provider credentials are scoped to the selected
workspace and must be treated as available to all commands in that workspace.
Protected stores and broker signing material remain outside the native domain.

Network policy for existing proxy clients stays with the existing egress
implementation. Do not extend that proxy into a universal native network
mediation system. For the OS sandbox, validate both outbound connections and
usable local development listeners alongside filesystem denial. Narrow internal
tasks with no network needs retain the inexpensive offline configuration.

Browser, workerd, and mobile app boundaries remain required. They provide
their own origins, runtime and platform permissions; they do not inherit a
desktop executor's grants. Websites never receive native workspace authority.

## Ownership and lifecycle

The installed launcher and protected receivers establish the workspace
incarnation, resolve resources, and record the applied MXC policy. The trusted hub authenticates requests, coordinates routes and enforces
application approvals. Separating these responsibilities does not require
additional OS boundaries inside the installed application. Revocation prevents new broker effects and
closes broker-owned routes. Direct filesystem or device exposure can survive
process cancellation while a descendant remains alive and must be reported as
such.

Workspace stop retires the control session before storage is reclaimed. Any
residual process state is recorded and quarantined; storage is never reassigned
on the assumption that a PID or root launcher exit proves complete cleanup.
An ordinary restart does not promise a fresh security domain. Separate
workspaces are required for mutually untrusted native workloads.

## Workspace deletion

The catalog first renames a discarded workspace into a protected trash directory
with a deletion receipt. Recursive deletion runs as installed Node inside MXC,
with write access only to the discarded workspace subtree and networking denied.
Its installed runtime is read-only; Windows stages that runtime beside the
workspace, under the protected trash parent. The host never recursively removes
workspace-authored contents. It removes the empty workspace anchor, its own
runtime files, the receipt, and the empty trash directory.

This reuses the accepted MXC filesystem restrictions instead of maintaining a
Rust executable for symlink-race-resistant deletion. A surviving workspace
process can interrupt cleanup by changing contents, but cannot expand the
cleanup process's resource grants. Failure, timeout, or a nonempty directory
retains the deletion receipt and staged runtime for the existing recovery path.
MXC failure never falls back to unrestricted recursive deletion.

## Verification and unfinished programme

The following work remains open and is required before calling the programme
complete:

1. Run the native workspace, Claude, receiver, and adversarial suites on real
   supported Linux, macOS, and Windows systems, including packaged Electron
   and headless npm products.
2. Extend the implemented production disk worker and receiver wiring with
   cross-platform and packaged evidence. Raw disk operations stay in the shared
   workspace process over one bounded typed port; there is no host-local
   execution fallback or trusted context construction in that worker.
3. Prove expected native tool networking on supported systems, including local
   servers and client connections. Keep existing proxy enforcement unchanged;
   no universal native network integration is planned.
4. Complete credential acquisition, external
   file effects, device effects, and host-terminal review against the accepted
   shared-workspace model.
5. Verify source, bundle, Base, system-test, installer signing, update, and
   crash-recovery paths. The same policy and ownership facts must hold in
   source, packaged, desktop, headless, and managed test launches.
6. Publish a release acceptance ledger containing backend identity, policy
   identity, target, owner/incarnation, residual cleanup result, and the exact
   test evidence. A Linux pass or a successful readiness response is not a
   cross-platform security certification.

There is no legacy launch fallback, alternate enforcement implementation,
state migration, or compatibility reader in this cutover. If a required
operation cannot be confined under the accepted MXC contract, the design must
be revisited before release rather than silently running it on the host.

## Feature obligations and related plans

The [Base extension survey](base-extension-host-access-survey.md) remains the
inventory of host effects. Required integration work is tracked here:

| Feature                            | Required treatment                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser import                     | Select browser/profile/categories at a protected receiver; parse bounded snapshots in confinement and disclose selected results. Keep sensitive stores outside ordinary workspaces. |
| Mobile debug                       | Select devices and operations at the receiver; no general adb socket exposure. Separate confined builds from authorized signing, installation and launch.                           |
| Local models                       | Admit selected model files and GPU resources, owned caches and scoped listeners. Persistent model-file reads may survive cancellation.                                              |
| Linked Claude                      | Separate stock MXC provider launch with explicit runtime/context reads, disposable profile and provisioned login. Provider networking is explicit and not broker-mediated.          |
| Shell and test runner              | Confined PTYs and toolchains; preserve browser/workerd/native runtime selection. Host terminals require fresh explicit approval for each opening.                                   |
| File tools, images, PDF ingestion  | Confined native operations and bundled runtime assets; ordinary use needs no external host grant.                                                                                   |
| React Native and typecheck service | Confined jobs with selected sources, dependencies and caches. Ordinary registry networking is available within the sandbox.                                                         |
| Other surveyed extensions          | Retain portable runtimes and bounded service calls; do not add host access merely because an extension has native dependencies.                                                     |

This plan owns isolation work in the runtime, authority, credential, browser,
network, workspace-test and host/userland plans. Their product and protocol
requirements remain in force. Existing browser/workerd boundaries remain;
there must be no parallel native confinement implementation. Findings in
historical security reviews feed the same release evidence rather than a
separate claim of completion. Context attribution is provenance, not native
command separation or perfect information-flow tracking.
