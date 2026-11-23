# Native storage evidence before collection-owned erasure

Inventory before edits:
- WorkerdManager.destroyStorageFiles is the sole native-prefix unlink primitive.
  It is used by destroyDurableObjectStorageFiles for stopped-generation retired
  GC (collectRetiredDurableObjectStorage), reset, restore, and orphan clone
  destroy; shutdown schema-probe reclamation calls it directly.
- Reset/restore already quiesce and make ordinary storage backups. Those backups
  are swept to five; retired destroy never made one. Neither is capture custody.
- durableObjectStorageClone.retire removes private clone staging/bookkeeping,
  not the native-prefix files. Storage clone sweep and ordinary backup sweep do
  not own capture-evidence roots and must not delete them.
- Runtime entity cleanup retires authority/handles and journals native reclaim;
  it has no campaign lifetime. Existing paid-exchange retention covers model
  evidence, not a pre-run Eval or another object's complete native SQL state.
- collect-live-workflow-teacher.mjs launches managed System Test instances,
  joins stop, moves their retained generations into capture/retained-state-*,
  and the Python campaign hashes/archives those opaque roots before cleanup.
  This existing owner outlives individual tasks and owns the new snapshot root.
- Host startup systemTestInstanceMode and bootstrap/workerd form the trusted
  process boundary. A collector-only environment flag plus managed-test mode
  enables retention; no guest argument, RPC storage reader or authority changes.
- All engines are outside this mechanism: native state can disappear before any
  model call. No inference/gateway/training changes are required or performed.

Barrier: before every native-prefix unlink in a collection-owned instance, copy
all exact regular prefix files into a private stage, bind every byte to SHA256,
check source identity/stability and membership, and verify SQLite including WAL
in a disposable verification copy. Atomically publish a content-addressed archive
and manifest under state/capture-evidence/native-storage. Existing native owner
quiescence/fencing remains mandatory. Originals are not normalized, checkpointed,
or removed by the snapshot. Failed copy/verification/publication means no unlink
and no completed maintenance. Repeated maintenance validates/reuses the same
immutable snapshot. Capture archives are outside ordinary backup/clone GC.
Normal user deletion outside explicitly collection-owned managed instances is
unchanged; env0 is the explicit collector opt-out.
