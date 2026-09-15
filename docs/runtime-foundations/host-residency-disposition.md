# Host residency disposition

This records the completed P1 residency disposition derived from the exact
reviewed host-method census. The generated census contains zero
`legacy-product:*` markers; migrated product domains are listed by their
current owner rather than by a temporary migration phase.

| Service families                                                                                                                    | Current disposition                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Browser data policy and persistence                                                                                                 | `vibestudio.browser-data.v1` product builtin; native browser effects remain kernel-native            |
| Panel tree state and navigation policy                                                                                              | `vibestudio.workspace-state.v1` product builtin; host presentation remains native                    |
| Executable-unit lifecycle, health, logs, versions, and rollback                                                                     | `runtime.supervision.*` with exact driver identities                                                  |
| Mission and system-agent policy                                                                                                     | workspace-owned reviewed closures and workers                                                        |
| Development bookkeeping                                                                                                            | workspace development worker; native controller/executors remain kernel-native                       |
| `account`, `hubControl`                                                                                                             | `identity`                                                                                          |
| `credentials`, `remoteCred`                                                                                                         | `secret`                                                                                            |
| `authority`, `browserPermissions`, `contentTrust`, `contextIntegrity`, `corsApproval`, `governance`, `permissions`, `shellApproval` | `grant-authority`                                                                                   |
| `app`, `desktopEvents`, `externalOpen`, `fs`, `menu`, `notification`, `view`                                                        | `native-effect`                                                                                     |
| `build`, `developmentClientExecutor`, `eval`, `evalExecutionRoots`, `workers`                                                       | `untrusted-execution`                                                                               |
| `durableWork`, `hostLifecycle`, `panelRuntime`, `presence`, `shellPresence`, `workspacePresence`, `workspace.heartbeats.*`          | `supervision`                                                                                       |
| `audit`, `evalEventIngress`, `panelLog`, `serverLog`, `workerLog`, `workerdInspector`                                               | `observability`                                                                                     |
| `blobstore`, `vcs`, protected workspace mutations                                                                                   | `protected-write` for exact mutation methods; opaque bounded reads are `transport`                  |
| `docs`, `events`, `extensions` invocation, `gateway`, `mirror`, `push`, `webhookIngress`, bounded workspace reads                   | `transport`                                                                                         |

The ratcheted baseline reports the remaining mixed handler-family count
separately; it is not represented by temporary product-residency labels.

P1 is complete: `settings`, `onboardingStatus`, and `palette` have no host
services or schemas. Palette contributions and dispatch are shell-local
panel↔shell events.

P7 Git inversion is complete: `gitInterop` is a manifest-selected userland
provider contract, not a host service. The bridge owns Git validation, repository
publication, config preparation, and reconciliation scheduling. The kernel exposes
only generic prepared workspace-config publication plus credential, egress, and
protected-write primitives.
