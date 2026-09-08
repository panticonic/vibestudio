# Website endpoint policy review

Reviewed 2026-09-08 against the public Host service schemas in this checkout and
the userland RPC receivers in `/home/werg/vibestudio-release-work/base`. The
review is bounded to the listed public entrypoint families and is not a full
security audit of every receiver or callback implementation. The
eligibility decision is about the effect of the entrypoint. A receiver's
internal calls do not make an otherwise reviewed endpoint closed: the current
browser caller remains the website principal, while `initiatingWebsite` is
attribution for review and audit.

## Reviewed inventory

| Surface                                                                                                         | Website policy | Review decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `templates.inspect`                                                                                             | eligible       | Exact pinned source inspection is a bounded disclosure used before installation. Moving source resolution, authoring inspection, and publication remain closed because they resolve mutable sources, inspect protected workspace code, or publish externally.                                                                                                                                                                                                                                              |
| `hubControl.createWorkspace`, `hubControl.workspaceCreationReceipt`                                             | eligible       | Workspace creation and minimal receipt reconciliation are the deliberate website installation API. They remain independently gated by the durable operation id and exact template review. Hub inventory, routing, membership, device, and deletion methods remain closed. The current approval copy is generic and its resource presentation shows only the operation id; the visible review should disclose the requested workspace name and exact pinned template before this is considered complete UX. |
| `docs.*` discovery                                                                                              | eligible       | Discovery is filtered to the connected caller's callable methods and exposes schemas/metadata only.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `gateway.fetch`                                                                                                 | eligible       | The stream is a workspace gateway asset fetch with the ordinary network/resource gate; it does not provide a bearer or arbitrary external egress.                                                                                                                                                                                                                                                                                                                                                          |
| `fs` content, directory, metadata, mutation, search, and `open`/`handle*`                                       | eligible       | These are caller-scoped workspace operations. Paths and handles are still bounded by the filesystem authority, ordinary resource consent, context boundary, and server-owned handle lifetime. A handle id is not a portable capability.                                                                                                                                                                                                                                                                    |
| `fs.nativeRoots`, `realpath`, `ensureMaterialized`, `readlink`, `symlink`, `chmod`, `utimes`, `mktemp`          | closed         | These expose physical host layout, raw materialization, link/metadata controls, or native-only lifecycle details. Websites use the reviewed virtual filesystem methods.                                                                                                                                                                                                                                                                                                                                    |
| `credentials.proxyFetch`, `credentials.proxyGitHttp`                                                            | eligible       | Host-side proxying can authorize one concrete destination and credential without returning secret material.                                                                                                                                                                                                                                                                                                                                                                                                |
| Credential storage, connection/input, OAuth callback/cancel, listing/resolution, revocation, capture, and audit | closed         | These own secret lifecycle, interactive identity, callback delivery, or credential inventory. Model availability remains secret-free and separately exposed by Base.                                                                                                                                                                                                                                                                                                                                       |
| events/callback watches and low-level workspace/channel/runtime state                                           | closed         | These create long-lived subscriptions or disclose/control durable workspace topology. Ordinary conversation sharing still needs its own bounded public integration.                                                                                                                                                                                                                                                                                                                                        |
| Base `ModelSettingsDO.listCatalog`, `getSettings`, `getDefaultModel`, `inspectModels`                           | eligible       | These read projections contain model metadata and secret-free availability needed by portable chat clients. They do not authorize model use or reveal credentials. `setDefaultAgentConfig` remains closed.                                                                                                                                                                                                                                                                                                 |
| Base terminal-chat host session controls and AgentVessel lifecycle/subagent methods                             | closed         | These control a retained terminal, agent execution, callbacks, or orchestration state. A website chat client should use the reviewed portable runtime surface and ordinary conversation records rather than host controls.                                                                                                                                                                                                                                                                                 |

## Changes made

Base commit `549c835` records the model-settings change. The supported userland
test suite passes all 22 tests, including a host-attested website caller and
an explicit closed-receiver rejection for the write. The Host schema census
passes 20 tests. This is a bounded review of the surfaces listed here, not a
complete effects audit of every existing receiver.

Base's four read-only model-settings methods now explicitly declare
`website: { kind: "eligible" }` and include `website` in their receiver
principal list. A focused Base test dispatches as a website caller, checks the
returned projections for secret-free shapes, and confirms
`setDefaultAgentConfig` remains closed. The Host contract
census also now indexes the committed `workspaceCreation.ts` and
`websiteHosting.ts` schemas; this keeps the repository-wide schema check aligned
with the public inventory. The Host service schema review is recorded in this
artifact; the census test validates schema coverage, while the endpoint
decisions above remain an effects-based review rather than a static policy
mirror.

## Remaining review gaps

The ordinary conversation storage/access API now has a bounded portable client
and explicit channel replay/send/subscribe eligibility. Declaration tests cover
that boundary; a real connected website channel exchange remains unverified.
The shared scaffold uses that client for durable history, message send, and cancellable live delivery.
Model launch and credential-backed inference acceptance remain open: this slice
does not claim that a website can start a model turn or that credential review
has been exercised through the shared application. Native mobile/device
acceptance, full callback delivery acceptance, and end-to-end website creation
receipt reconciliation remain outside this policy-only review. The
workspace-creation approval now identifies the requested workspace name and supplied
exact template URL/ref/commit/snapshot through a shared prepared authority resolver
(Host `ba985cd36`). A request without a pin explicitly identifies the host-selected
default instead. The operation ID remains the durable grant/receipt key. The broad
userland receiver census has explicit annotations, but each receiver's
method-level effect review should continue as those APIs become public.

## Live authority census follow-up

Native website installation acceptance exposed an omitted transport in the generated
approval vocabulary: the actual hub service lives outside the workspace/desktop service
factory directories. The hub now has its own snapshot of the real service definition.
All catalog, residency, manifest-inference, and ledger consumers share one loader. The
merge resolves inherited authority inside each transport and rejects incompatible
contracts; the workspace facade's principals cannot become defaults for hub-only methods.

The refreshed snapshots record 13 workspace-server method additions, 26 changed methods,
the website-capable defaults of credentials/docs/gateway, four native view updates, and
22 hub methods (two exactly shared with the workspace facade). The changes match the
live schemas and handlers. Explicit review entries cover filesystem website-only gated
leaves, retained-content ownership, extension dispatch, creation/receipts, retained Claude
controls, hosting lifecycle, filtered discovery, and exact source acquisition. The
reviewed projection digest is
`sha256:fdece0351c890acac7b837f8d78ca217b729f32f6fabdcd4337945b60b3f8355`.

Five live census tests and 22 shared matrix/inference tests pass. Native Electron
acceptance also passes creation, document reload, reconnection, and separately approved
receipt recovery (`20260908T141703896Z-3431952-a9fce9e4`, 55.5 seconds test). Its owned
instance and display were cleaned up. The authority digest does not include website
annotations and therefore is not proof of website-policy enforcement by itself; the
bounded schema/handler and native tests supply that evidence for their covered paths.
