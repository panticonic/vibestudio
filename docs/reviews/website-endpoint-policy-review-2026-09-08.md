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

The ordinary conversation storage/access API and its website-facing delivery
boundary still need a separate bounded integration. Native mobile/device
acceptance, full callback delivery acceptance, and end-to-end website creation
receipt reconciliation remain outside this policy-only review. The
workspace-creation approval prompt also needs a bounded presentation follow-up:
`createWorkspace` currently presents generic "Create a workspace" copy and
derives its target from `operationId`, so the user-facing card does not yet
identify the requested name or exact root-template pin. The broad
userland receiver census has explicit annotations, but each receiver's
method-level effect review should continue as those APIs become public.
