# Manual obsolete-workspace rescue is not supported pre-release

Status: retired by the pre-release clean-cut policy, 2026-08-12

The former procedure started an external agent against an old workspace so it
could repair enough internal state to enter the normal template migration path.
That is compatibility infrastructure: it requires old-state inspection, host
migration notes, a rescue authority boundary, and a second operational path.

It must not be implemented or used before the first supported release.

For a controlled pre-release instance:

1. Stop it through its normal instance owner.
2. Export only deliberately retained user-level facts through an ordinary
   product export surface, if one exists.
3. Delete the obsolete workspace/runtime state with exact scoped targets.
4. Recreate from the current exact external Base.
5. Install current official templates and import retained product data through
   current APIs.

Do not give an agent obsolete internal metadata and ask it to make that metadata
admissible. Do not read `migrations/system`, system notes, prior Composer state,
builtin databases, or old route records. If a fact has no honest product-level
export/import path, it is discarded in the pre-release cut.

After the first supported release, a real recovery or migration procedure must
be designed from the concrete durable user data and availability contract. This
retired document grants no authority for that future operation.
