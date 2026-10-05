# Agent chat affordance repair

The native harness upgrade lost incremental queue flushing, turn-level waiting
notices, and per-run automation transcript details. These changes restore them;
fallback-model notices remain unchanged.

`Conversation.flush()` admits an interruption in the actual native run. Native
cancellation joins the existing request and owned tools, then consumes steering
input or starts the next follow-up. It preserves queued submission identities and
their read receipts. Ordinary Stop continues to withdraw queued inputs. The
client joins the RPC result and displays its original failure instead of claiming
the interruption succeeded.

Credential and background-report waits retain presentation alongside the exact
native readiness condition. Publication follows the run's actual blocking task
dependencies through the harness commit's candidate task view. Running parallel
work remains active; wait/resume events share the original turn identity. Waiting
keeps Stop available, and each agent gets one Stop control when automation and
model activity overlap.

Automation transcript rows follow the retained native lifecycle for prompt,
direct Eval, and watch runs. Public provenance supplies the name and schedule;
the original terminal supplies status and summary. Owner identifiers and authority
session nonces are excluded from this projection. Delivery uses the existing
ordered, durable channel-publication tasks.

The Base and dependent templates pin the coherent `0.99.2-vibestudio.12` harness
libraries. This release also integrates upstream library changes through 1.0.3
and commit `5b6c792b`: OAuth refresh cancellation, Azure Foundry deployments,
HTTP/2 stream retry, bounded filesystem and shell reads, filesystem watches, and
configurable progress intervals. Azure's provider identity is now `azure`; the
`azure-openai-responses` API identity is unchanged. The host credential policy
and template fixtures use the canonical provider identity.

Source is tagged `vibestudio-pi-0.99.2-vibestudio.12` in the maintained fork.
The registry verification receipt is `docs/durable-pi-package-release.json`.
Validate a packed package release before publication from the host checkout:

```sh
pnpm test:userland -- --template base --package-release /path/to/release.json \
  --filter packages/agentic-do/src/native-channel-publication.test.ts \
  --filter packages/agentic-do/src/native-suspend-tool.test.ts \
  --filter packages/agentic-do/src/native-model-provider.test.ts \
  --filter packages/agentic-do/src/native-automation-runs.test.ts \
  --filter packages/agentic-chat/hooks/core/useChatCore.send.test.tsx
pnpm type-check:userland -- --template base --package-release /path/to/release.json
```

The host validation option checks archive hashes, embedded package identities,
and the declared version/dependency closure before installing the packed release
with lifecycle scripts disabled. It owns a disk-backed installation under the
host `.cache` directory and removes it after validation, including on failure.
Template source checkouts receive no package-manager or compiler state. Runtime
workspace installation retains the normal registry dependency boundary.
