# Isolation feasibility investigation — 2026-09-05

> Scope update after this investigation: the user approved one native sandbox per workspace, shared by its commands, with best-effort cancellation. The [canonical plan](../isolation-plan.md) supersedes this report's per-job/context separation and strict descendant-retirement gates. Native macOS Seatbelt is the implementation direction; a Linux VM is not required by the revised contract. The executed results below are unchanged historical evidence; native Mac/Windows runtime validation and full application cutover remain outstanding.

Decision: proceed with the Linux native-domain design and a Windows native prototype. Do not lock the cross-platform architecture yet. Linux execution primitives passed useful real-runtime probes, but the tested prebuilt hub cannot start with external networking removed. macOS still lacks a demonstrated mechanism for dynamic per-job isolation under one shipped helper identity.

This is the first executed U1 investigation for the [canonical isolation plan](../isolation-plan.md). It is not a completed U1 gate or a security certification. No production launcher, authority policy, operating-system configuration or release workflow was changed.

## Executed Linux evidence

Reproduce with `node scripts/isolation-feasibility/linux.mjs` from the repository root. The fixture prints JSON and exits nonzero if a probed requirement fails. `--gui-only` and `--hub-only` repeat just the relevant experiment. The [recorded result](isolation-feasibility-linux-2026-09-05.json) includes the known hub failure; that failure must not be converted into a passing expectation for product acceptance.

Host: Linux x86_64, kernel `7.1.1-76070101-generic`, bubblewrap `0.6.1`. Orchestrator Node `25.4.0`; confined Node `/usr/bin/node` `24.0.1`. Installed dependencies exercised: Electron `43.2.0`, workerd `1.20260724.1`, node-pty `1.1.0`, ripgrep package `1.18.0`.

Source checkout: `037872915caa375a7480089a71dbbaca4384d4a3`, with existing working-tree changes. Configured Base: `b70fc5def51de10cc7a2bb6ddfe857587712c041`. The hub experiment used the existing built `dist/server.mjs`, SHA-256 `f330bacfd36cae42a749b1ffab2e41ab6d9cf01f681ae5133c4fb9e50a6076db`; it was not rebuilt or assumed identical to current source. Base workspace bootstrap was not reached.

The launch uses unprivileged user, mount, PID, IPC, UTS and network namespaces, drops capabilities, clears the environment, supplies private `/proc`, minimal `/dev` and temporary storage, and mounts each job's input read-only and state writable. It exposes a single fixture Unix socket for mediated effects. The host home, session bus and X11 connection are not mounted. Installed `/usr` and project dependencies are read-only fixture runtime inputs, not an audited minimal production runtime image.

| Experiment | Executed result | What it establishes |
| --- | --- | --- |
| Unprivileged bubblewrap launch | Passed without sudo or OS configuration changes | This machine permits the required basic namespace mechanism. Other Linux distributions/policies remain untested. |
| Concurrent A/B jobs, same executable and OS account | Passed in two rounds | Separate readable inputs and writable state; host and sibling canaries inaccessible; host environment and process absent. The two rounds model workspace and context domains; they do not exercise production workspace/context identity mapping. |
| Read-only input; generated child code | Passed | Writes return `EROFS`; generated Node code executes and retains host-file denial. |
| Real ripgrep, Node native module and PTY shell | Passed | Installed ripgrep searches selected input; installed node-pty runs bash through private PTYs. |
| Real workerd | Passed in both concurrent domains | Both bind the same private loopback port and serve a worker response independently. This is not the full workspace worker graph. |
| Network denial and mediated access | Passed | A host listener is reachable by the parent but inaccessible directly from jobs. An explicit Unix-socket receiver reads a selected synthetic host file and performs a fixed HTTP request on their behalf. Unknown resource requests are denied. |
| Revoke, retire, restart | Passed | Receiver rejects revoked token; detached descendant stops updating its heartbeat after owner exit; B remains usable; restarted A lacks its old input mount. Existing scratch intentionally remains the same domain's state. |
| Electron main and renderer on private Xvfb | Passed with software rendering | Window creation and renderer JavaScript work with `sandbox: true`, no `--no-sandbox`, no host display mount. Main-process host-file read and Chromium-network request to host loopback fail. |
| Real prebuilt hub | **Failed readiness** | Iroh requires online transport; confined DNS sends fail with `ENETUNREACH`, followed by `Iroh endpoint did not become online within 15000ms`. |

The fixture's token receiver is deliberately small and synthetic. It demonstrates crossing a namespace through one socket; it does not implement production principal authentication, protected approvals, wrong-owner enforcement, credentials, resource selection UI, prepared-effect commit/revocation races, or denial of forged controller facts. Its HTTP request is fixed to a synthetic local listener, not a general destination-policy implementation.

The desktop probe initially hit Xvfb's installed NVIDIA/GLX initialization failure. The completed probe disables GLX in its private display and GPU use in Electron. This gives a useful software-rendered compatibility result, not GPU, native desktop integration, visual-quality or performance evidence. Missing private font configuration and D-Bus generate warnings. Host X11 access must not be introduced as a convenient way to pass desktop integration: this workstation has X11 and no exposed Wayland compositor for that experiment.

The hub failure is a concrete architectural finding. The native transport performs its own DNS/network operations; Node fetch policy or proxy environment variables are insufficient evidence of containment. A scoped transport route or an installed transport service with narrow authenticated IPC must support Iroh before the complete confined hub/workspace startup experiment can pass. Do not move the whole server outside or grant all native jobs the hub's network access. The existing workerd egress route is already wired and should be incorporated, not reimplemented based on stale audit claims. Relevant sources: [hub control transport](../../src/server/hubServer.ts), [Iroh readiness](../../src/server/irohIngress.ts), [workerd egress](../../src/server/workerdManager.ts).

Each completed run awaited its owned bubblewrap processes, closed fixture listeners and removed private temporary state. PID namespace teardown contained detached descendants. An initial fixture socket-error bug was corrected; its leftover synthetic temporary directory was separately removed. No existing developer instance was reused or stopped. These are direct process/mechanism probes, not agentic system-test or profiling runs.

## Windows: documented path, native execution pending

Windows supports creating distinct AppContainer identities for domains while launching the same executable. The launcher can grant per-SID file access and private state, omit broad network capabilities, and expose selected IPC. Programmatic AppContainer launch does not require replacing NSIS with an MSIX identity. LPAC is a candidate for reducing ambient access further. These are documented capabilities, not runtime results from this investigation. [Microsoft AppContainer launch](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).

Apply security capabilities, the explicit inherited-handle list and Job Object membership during process creation. Keep the kill-on-close job handle in the trusted launcher and disallow breakaway. This is a concrete implementation path for initial authority and owned lifetime. [Process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

Mandatory falsifiers include ConPTY/node-pty, Electron renderer creation, workerd, generated binaries, native modules, and launch requests through COM/WMI/services. Microsoft specifically documents that `Win32_Process.Create` children do not inherit normal job membership; that route must be inaccessible or mediated. The existing `taskkill /T /F` cleanup is not an adversarial lifetime boundary. [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [current cleanup](../../scripts/owned-process-tree.mjs).

## macOS: resolve the mechanism before implementation commitment

The current DMG/ZIP build uses ordinary Electron `darwin`, Hardened Runtime and JIT/library-loading entitlements. It does not enable App Sandbox. Electron documents App Sandbox support in the MAS build, with feature differences and signing implications even for outside-store distribution. Packaging and native dependencies need an actual signed-artifact experiment. [Electron guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide), [current entitlements](../../build-resources/entitlements.mac.plist), [builder configuration](../../electron-builder.yml).

App Sandbox and XPC can separate fixed signed targets. They do not alone prove that concurrent instances of the same helper can have different workspace/context resources and private scratch. Static inheritance and dynamic selected-file access must be tested explicitly. Network entitlements are coarse permissions, not destination policy. [Apple sandbox entitlements and inheritance](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).

There is no basis for treating `sandbox-exec` as a supported drop-in equivalent of bubblewrap. Apple DTS states that custom SBPL is unsupported for third-party development. Chromium maintains a Seatbelt backend; choosing that route would be an explicit maintenance commitment with an OS-version compatibility matrix. [Apple DTS](https://developer.apple.com/forums/thread/661939), [Chromium Seatbelt design](https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/mac/seatbelt_sandbox_design.md).

The independent review found a new candidate worth testing: Apple's macOS **27.0 beta** descendant-scoped Endpoint Security client. The live documentation metadata identifies it as beta and introduced in 27.0. It avoids root/TCC requirements for its descendant scope, but still requires the restricted Endpoint Security entitlement. A related beta API provides fail-closed deadline/queue-overflow behavior. Neither document establishes the whole required filesystem/network/lifetime boundary, especially after the enforcement client crashes. This is not a backend for unspecified older macOS versions. [Descendant client](https://developer.apple.com/documentation/endpointsecurity/es_new_descendants_client(_:_:)), [deadline behavior](https://developer.apple.com/documentation/endpointsecurity/es_set_deadline_miss_mode(_:_:)).

A Network Extension content filter is another documented networking primitive, with its own capability and deployment cost. Investigate it only if required native socket workflows cannot use scoped IPC. [Apple filter provider](https://developer.apple.com/documentation/networkextension/nefilterdataprovider).

If the supported lightweight mechanisms cannot express the required scopes, change the architecture explicitly: evaluate a maintained Seatbelt implementation or a shared VM execution substrate. Do not waive the invariant or silently equate either with App Sandbox. The user-facing desktop boundary would still need its own solution.

## Remaining gates and next engineering work

1. **Transport and desktop on Linux:** choose the enforceable Iroh network placement, then run the actual hub, exact Base workspace, extension host and graphical client together with denial tests from each role. Prove real desktop/GPU channels separately from private Xvfb. Review the runtime mount closure, seccomp and distribution support before shipping.
2. **Windows native prototype:** run the same-helper A/B tests using AppContainer SIDs and creation-time Job Object membership, then the actual runtime/native-dependency set. Include service-mediated child escape attempts.
3. **macOS mechanism and support matrix:** test the same helper concurrently, not two separately signed demo apps; establish signing/distribution, private state, network denial and descendant retirement. Resolve stable-version support and entitlement availability before choosing the beta Endpoint Security avenue.
4. **Protected receiver:** test actual identities, approvals, grant revocation and prepared commits. The synthetic socket fixture does not satisfy this part of U1.

Only Linux native execution was available locally. No Mac/Windows execution connection was identified or supplied during this investigation. Existing macOS CI and conditional release signing are potential infrastructure, not executed confinement evidence; no Windows CI runner was found. No workflows were dispatched or credentials changed.

The independent agent reviewed the plan, discussed improvements and confirmed their integration: same-helper concurrent scopes; generated code retaining job authority; protected origins of identity/resource/approval facts; denial tests per process role; distinction between destination and HTTP-level policy; and independent substrate acceptance while retaining the full product obligations.

The work remains **major overall**, but the risks are better localized. Linux's native command compatibility is encouraging. The immediate design uncertainties are native transport/desktop integration and macOS enforcement; the broad workload after those are resolved is authority and lifecycle integration across the application. No defensible delivery date follows from these probes.
