# Native execution and isolation

Status: accepted platform architecture; release acceptance requires native and packaged evidence for each supported target (2026-09-06).

The installed application, controller, hub, runtime engines and protected
receivers are trusted. Workspace-authored code executes through a common native
runtime with an explicit platform contract. Containing the installed application
itself is not a requirement.

## Platform contracts

| Platform            | Native execution                            | Filesystem and operating-system guarantees                                                                                                                                    |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x64 and ARM64 | Stock pinned MXC 0.8.0, using bubblewrap    | Read-only installed runtime and selected inputs; writable workspace state. Unadmitted host and sibling files are inaccessible.                                                |
| macOS ARM64         | Stock pinned MXC 0.8.0, using Seatbelt      | Selected filesystem resources, with read/write access to `/dev` for working native terminals and tools. Device and unrelated terminal isolation are not promised.             |
| Windows x64         | Direct host process under the app's OS user | Normal user access to host files, sibling workspace files, processes, devices, desktop facilities and networking. No native filesystem, network or UI confinement is claimed. |

Windows host execution is the selected architecture, not a fallback after a
sandbox failure. Windows ships no MXC executor and needs no AppContainer ACL or
loopback provisioning. Private workspace directories, homes and explicit
process environments still organize execution and prevent accidental ambient
configuration inheritance; they do not protect host data from Windows native
workspace code. Windows workspace commands must be treated as trusted to act
with the user's operating-system permissions.

Windows long workspace database paths require the operating system's
`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` policy to be
`1`, in addition to the application manifest installed beside stock workerd.
Vibestudio does not change this machine policy. The native acceptance suite
reports its value and exercises long database paths under both administrator
and standard-user identities; support is established by those execution tests,
not by the presence of the manifest alone. SQLite's selected Windows VFS also
has an upstream 1040-byte filename limit. See the
[Windows long-path requirements](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)
and [SQLite Windows VFS limits](https://www.sqlite.org/vfs.html).

On Unix, MXC owns native policy generation and enforcement. Vibestudio supplies
resource admission and does not maintain a parallel bubblewrap or Seatbelt
implementation. MXC is preview software whose upstream documentation cautions
against treating its generated profiles as a hardened security boundary. The
product does not promise protection against compromised kernels, administrators,
other unrestricted processes belonging to the user, or all resource exhaustion
and side channels.

## Shared execution model

One resident native runtime serves each workspace's commands, shells, builds,
tests and native extensions. Context and command IDs establish routing and
provenance; they are not separate native security domains. Linked Claude uses a
separate native launch with selected runtime/context inputs, a disposable profile
and deliberately provisioned login. It follows the same platform contract:
MXC on Unix and direct host execution on Windows.

The installed standalone Node distribution supplies the actual Node executable,
npm and runtime resources. Source, npm and Electron products use the same
installed resource resolvers and explicit execution mechanism. Unix MXC payloads
are staged under `dist/mxc/<platform>-<arch>`; Node distributions are staged under
`dist/node/<platform>-<arch>`. Packaging validates the selected target's payloads.

Cancellation and descendant cleanup are best effort. Closing a command or the
root process does not prove every descendant stopped. Commands in one workspace
share its exposed resources. Separate Unix workspaces provide separate native
resource admission; separate Windows workspaces do not establish an OS security
boundary.

## Application authority and resources

The trusted owner derives launches from authenticated workspace ownership,
installed executable identity, selected source and scratch roots, explicit
environment, control handles and the live authority decision. Workspace-supplied
labels, paths, PIDs and readiness responses are not proof of identity or
containment. Services continue to authenticate requests, enforce workspace and
context provenance, check approvals, and authorize protected effects.

Managed source, authority records, credential stores and broker signing material
remain owned by protected services. Semantic import/publication is the authorized
application path into managed state. On Unix, native admission additionally keeps
those unexposed files outside workspace code's filesystem access. On Windows,
service ownership and protocol checks do not prevent a native process with the
same user's host permissions from accessing or tampering with their underlying
files. Documentation and UI must not present service authorization as equivalent
to OS containment.

The process environment is explicitly constructed. Host shell startup files,
SSH agents, arbitrary API keys and ambient IPC handles are not automatically
inherited. Required credentials and tool configuration are deliberately
provisioned. Credentials exposed to a shared workspace must be considered
available to its commands. On Windows, a closed environment alone cannot stop
native code reading other user-accessible credential files or contacting host
services.

Direct-resource receivers must validate their own requests and ownership.
Symlinks, reparse points, hardlinks, traversal, case aliases and check/use races
require meaningful tests. Browser, workerd and mobile boundaries retain their
own origins, permissions and authentication. Websites do not receive native
workspace authority merely because a desktop process has it.

## Networking and terminals

Ordinary native commands and linked Claude have normal networking for package
downloads, CLI services and local development servers. Unix uses MXC's stock
open-network configuration; Linux shares the host network without a
slirp4netns dependency. Windows uses the user's normal host networking.

The pre-existing egress proxy, destination checks, approvals, credential handling
and callers remain unchanged. Native traffic is not universally forced through
that proxy. Reachable local services must continue to authenticate and authorize
requests. Existing browser origin/CORS and account protections remain in force.

Narrow internal Unix utilities, including credential extraction and workspace
trash deletion, use MXC's offline configuration. Windows utilities run directly;
no offline enforcement is claimed there.

The terminal panel must accurately identify its execution scope. A full-host
terminal on Unix crosses the workspace filesystem boundary and requires fresh
explicit approval. Windows workspace terminals already execute with host user
access; a private home or workspace label must not imply otherwise. Approved
host-terminal flows retain their application approval and provenance records.

## Ownership and retirement

The trusted hub establishes the workspace incarnation, authenticates requests,
coordinates routes and applies application approvals. Revocation prevents new
broker effects and closes broker-owned routes. It cannot retract filesystem,
device or network access from a surviving native process.

Workspace stop retires its control session before storage reclamation. Cleanup
records must distinguish confirmed root-process exit from unverified descendant
retirement. Storage must not be reassigned on the assumption that a PID's exit
proves complete cleanup; an ordinary restart does not promise a new security
domain.

For deletion, the catalog renames discarded storage into a protected trash
location with a receipt. The installed Node cleanup utility removes its contents;
the owner removes empty anchors and its own staging and receipt files. On Unix,
that utility runs inside MXC with only the discarded subtree writable and
networking denied. On Windows it runs directly with the user's host permissions.
The Windows operation must not be described as race-resistant containment of a
hostile surviving workspace process. Failure or interruption preserves the
receipt for recovery. No Rust cleanup executable or alternate native sandbox is
part of this design.

## Feature obligations

The [Base extension survey](base-extension-host-access-survey.md) is the historical
inventory of host effects. Current integrations follow these requirements:

| Feature                                                        | Required treatment                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser import                                                 | Protected acquisition of selected browser profiles/categories, bounded parsing and selected disclosure. Unix parsing uses admitted resources. |
| Mobile debug                                                   | Receiver-authorized devices and operations; preserve signing, installation and launch workflows without handing out general broker authority. |
| Local models                                                   | Selected model/runtime resources, accelerator access, owned caches and authenticated service interfaces.                                      |
| Linked Claude                                                  | Separate native launch, installed CLI/runtime closure, disposable profile and explicit credential acquisition/refresh reconciliation.         |
| Shell, builds and tests                                        | Real PTYs and toolchains, normal package/network workflows, correct platform execution disclosures and host-terminal approvals.               |
| File tools, image/PDF ingestion, React Native and typechecking | Workspace resource selection and owned outputs; Unix confinement and Windows host execution according to the platform table.                  |
| Other extensions                                               | Preserve portable runtimes and bounded service APIs; native dependencies alone do not confer additional application authority.                |

## Release acceptance

Acceptance must exercise each supported operating system and packaged product,
including ordinary-user Windows execution. Tests must establish:

1. Correct installed executable selection, literal argv, explicitly constructed
   environments, source and packaged startup, real PTY input/resize and native
   dependency execution.
2. Unix host/sibling filesystem denial alongside required resource access;
   Windows actual host access with no MXC installation or ACL changes required.
3. Working DNS/HTTPS, outbound local connections and local listeners; unchanged
   existing proxy authorization.
4. Shared workspace command behavior, cancellation, forced termination,
   concurrent resource owners, restart and interrupted cleanup recovery.
5. Protected receiver authorization, credential acquisition and reconciliation,
   source publication, browser/workerd boundaries and accurate approval UI.

Record target, execution mechanism, workspace/incarnation, residual cleanup
result and exact test evidence. A successful readiness response or Linux test
run is not cross-platform acceptance. Unexecuted platform tests remain unverified.

This document supersedes conflicting isolation requirements in runtime,
authority, credential, browser, network, workspace-test and host/userland plans.
Their product and protocol requirements remain in force. Dated feasibility and
review documents remain historical evidence. There is no legacy launch fallback,
state migration, compatibility reader or second native enforcement system.
