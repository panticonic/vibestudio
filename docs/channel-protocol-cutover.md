# Channel protocol storage cutover

The current channel owner schema is 124, the workspace source owner schema is
66, and the native agent owner schema is 4. Agent subclasses inherit the native
owner version. These owners declare no schema upgrade path. Admission checks
the sealed executable descriptor, stored schema version, and schema fingerprint;
incompatible storage is refused before mutation. Rebuilding an executable does
not reset its storage or convert old protocol records.

Current channel history, membership operation receipts, replay, registry, and
delivery identities belong to the channel's local immutable ledger. Workspace
graph publication and observation are separate owned obligations. Old streamed
DO subscriptions, provisional event cursors, delivery snapshot migrations, and
old publication broadcast entry points are not supported.

Lifecycle release joins peer publications first, then closes delivery over
actual channel commitment frontiers before sealing any owner's history. A new
frontier admitted by an already-owned recipient effect requires another closure
pass; elapsed time is not a readiness signal. Each delivery's original failure
belongs to its canonical mailbox record and survives owner reactivation.
Successful acknowledgement or authoritative retirement settles that debt; a
repaired delivery does not leave an activation-wide failure behind. Global
observation is joined only after this causal delivery boundary is closed.

## Exact reset boundary

`workers.resetStorage({ source, className, objectKey }, intent)` is the existing
host-owned maintenance operation for one explicitly disposable Durable Object.
It resolves the exact target in the caller's context, fences and joins its RPC
relays, retires the actual facet, backs up and integrity-checks its storage,
replaces that target's storage, and rotates its storage incarnation. A reset
does not replace workspace source code or admit an old executable as the current
protocol. Use a current sealed executable when reactivating the reset target.

Channel and native agent storage can be reset only when their retained
conversations, tasks, and approvals are explicitly disposable. A reset
invalidates that target's previous execution identity; it does not preserve
pending native tools or approvals. Other targets, running instances, and user
source must not be deleted as part of this operation.

The `GadWorkspaceDO` also contains the workspace's canonical semantic source and
version-control state. Resetting this entire owner to remove obsolete channel
protocol records would erase unrelated user data. Its whole-storage reset is
therefore **not a protocol-only cutover operation**. There is currently no
protocol-only maintenance API for that owner, and deleting selected tables or
rewriting its schema metadata directly would bypass its canonical invariants.

For isolated verification, provision a fresh workspace from the current source
templates and retire that exact owned instance afterward. For an existing
workspace, preserve its source and retained product data through their explicit
product export/import boundaries before choosing a destructive recreation.
Until that boundary is established, leave incompatible existing storage intact
and report the schema rejection. There is no automatic conversion, guessed
revision repair for old records, or fallback to the old executable protocol.
