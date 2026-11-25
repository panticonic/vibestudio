# Lifecycle integration with current main

This ordinary merge starts from origin/main8f82a1b93063e53ff72f897b41b34e780d280523 and preserves its Celld/Dolt architecture and template pins (Basee3a2859, Personal02352ba, Systemba53257). Production V27 is separately pinned and is not changed by this worktree.

Inventory before conflict resolution:

- Shared Ownership/reaper, ephemeral instance allocation, supervisor retirement, captureEvidenceOwnership and nativeWorkspaceRuntime remain host mechanisms with the same ownership boundaries. Their operation-scoped fixes are retained.
- The old Host builtin EvalDO and three modified tests were deliberately deleted upstream. Modern Basee3a2859 hosts `workers/eval-kernel/EvalKernel.ts`; its queue already discards raw results via `Promise.race([ran.then(noop, noop), abandoned])` (1568). It does not use the old catch-only fulfilled-result retention mechanism. No legacy EvalDO is restored.
- RuntimeManager replaces WorkerdManager. Its `DurableObjectStorage` coordinates Celld object retirement, recovery and `retainCelldStorageImage` before deletion (constructor788–801; retainRetiredCell4440ff). Preserve that protocol rather than reintroducing filesystem SQLite deletion/old maintenance tables. Existing modern tests prove capture failure keeps the retired cell and recovery retries publication. Incoming sealed-object/bearer ownership corrections still apply to the unchanged admission mechanism.
- UniversalDO now supports hosted Celld code/grants. Keep grants in executable cache identity while retaining the one-shot schema-probe loader correction.
- Host fingerprint must include both modern Chronolog native build identity and installed Node/dependency identity; neither replaces the other.
- Infrastructure cache mode-invalidation tests and the declared concurrency-budget test cover independent requirements; retain both.
- Disposable instance state is separate from explicit capture bytes. Current Celld storage capture remains intact; evidence root separation is not a storage-format conversion.

Main integration is not qualification of the V27 authored corpus against the newer Celld/Dolt templates. Those template commits are not descendants of the frozen V27 variants. Do not deploy this host with the old template codebase or silently regenerate/replace task goals. A coherent corpus/template migration remains separate work.
