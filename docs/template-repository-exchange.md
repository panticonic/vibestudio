# Template repository checkout exchange

Use the explicit exchange command when moving a manifest-declared template
projection between a materialized authoring tree and a sibling Git checkout:

```sh
pnpm template:exchange -- \
  --workspace /path/to/exact-template-tree \
  --checkout /path/to/sibling-checkout \
  --direction export
```

The command only plans by default. Review `projection`, `paths`, `untouched`,
and `conflicts`, then apply the printed `operationId` in a later invocation:

```sh
pnpm template:exchange -- \
  --workspace /path/to/exact-template-tree \
  --checkout /path/to/sibling-checkout \
  --direction export \
  --apply \
  --operation-id <printed-sha256>
```

Apply recomputes the plan and requires the supplied operation identity to match.
Any source, target, manifest, mode, projection, or baseline change therefore
invalidates the reviewed operation and requires a new plan.

`export` moves authoring-tree bytes toward the checkout. `import` moves checkout
bytes toward the supplied import tree. The three-way baseline and exact
receipts live under the checkout's actual Git directory at
`vibestudio/template-exchange/`, including linked-worktree `.git` files. They
are checkout-local operation evidence, not template source or an ambient cache.

The projection is derived from `meta/template.yml`:

- declared repository subtrees and declared support files are included;
- undeclared paths are reported as `untouched` and never copied or deleted;
- a dependency-free root includes a canonical generated
  `meta/vibestudio.yml`; and
- a contribution template with dependencies neither requires nor receives a
  flattened runtime manifest.

There is no Base flag. Root capability follows from the manifest's dependency
graph. The same exchange works for Base and optional contribution repositories.

## Three-way behavior

Each projected path is compared with the checkout-local common baseline:

| Status           | Meaning                                                     | Apply behavior                                              |
| ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `equal`          | Source and target agree.                                    | Refresh baseline evidence only.                             |
| `update`         | Target still matches the baseline; source changed.          | Write the reviewed source value.                            |
| `delete`         | Target still matches the baseline; source removed the path. | Delete only that reviewed projected path.                   |
| `target-changed` | Source still matches the baseline; target changed.          | Preserve the target for an exchange in the other direction. |
| `conflict`       | Both sides diverged from the baseline.                      | Refuse the entire apply without overwriting either side.    |

The target tree and checkout must be physically separate. Both roots are
canonicalized through filesystem real paths before overlap checks, so a symlink
alias cannot make one tree appear independent. Projected symlinks and other
non-regular entries are rejected. Writes use staged file replacement, and a
successful apply records the new exact baseline and receipt.

## Inside Vibestudio

This filesystem command is the external-checkout adapter. Inside Vibestudio,
the Base-owned Development workflow must supply an exact semantic context and
use the native semantic checkpoint/import effect; a materialized workspace
directory is never semantic authority. The flow is:

1. Base selects an absolute sibling checkout, direction, semantic context,
   repository identity, and expected working head.
2. The host resolves the checkout's real path, seals the exact intent, obtains
   an exact semantic source plan, and materializes it under the operation's
   private root.
3. Base presents the plan for review.
4. Apply must repeat the operation ID, intent digest, and same checkout
   coordinate.
5. Export writes only the reviewed checkout projection. Import mutates only the
   private materialization, scans it through the canonical native snapshot
   boundary, and submits one atomic semantic import with the expected head and
   stable command ID.
6. The host records the exact terminal receipt, removes the materialized source
   bytes, and retains a bounded terminal record so a lost response can replay
   without repeating semantic ingress.

The host never writes directly into a live semantic projection, and the
workflow never scans sibling or workspace paths that were not named by the
reviewed operation.

## Current evidence

Focused evidence recorded on 2026-08-13 covers:

- declared projection and untouched-path preservation;
- one-sided edit preservation and explicit reverse-direction import;
- divergent conflict refusal with both sides unchanged;
- exact-plan invalidation after source changes;
- required cross-invocation operation identity for standalone apply;
- physical-root overlap rejection through a symlink alias;
- contribution templates not receiving `meta/vibestudio.yml`;
- export terminal-receipt replay after a lost response;
- import terminal-receipt replay without a second semantic import; and
- rejection of apply against a different checkout coordinate.

These tests validate the exchange boundary. They do not by themselves promote
the provisional Base release or replace the final managed inside-system
self-development proof.
