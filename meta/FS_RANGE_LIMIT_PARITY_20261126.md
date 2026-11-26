# Native filesystem range limit parity

The browser-safe shared `fsReadLimits` module is the single source for unchanged50KiB default/1MiB maximum text/byte ranges. Both wire schemas and Node/disk normalization import it. This permits complete native readback clients to request canonical bounded slices without inventing a separate artifact ceiling.

Inventory: packages/service-schemas/src/fs.ts limits readText/readBytes wire options; src/server/services/fsValues.ts normalizes both; src/server/services/fsDisk.ts:266,297 and fsService.ts:887,898 consume those normalizers. Browser/Workerd/RPC callers use the same schema module; there is no model-engine-specific range implementation. The module has no Node imports. Core model backends do not implement Native filesystem protocol limits. Existing bounded source-read policies are unchanged and require per-goal audit before removal.

Production counterpart is e5312668b. Modern four actual schema/normalizer controls passed in vibe-modern-fs-range-parity-20261126b; first unit failed setup because isolated source lacked dependency resolution, then explicit immutable third-party Zod and modern source aliases fixed projection. No CellD/Native serving qualification or RSS benefit is claimed. Canonical foreign WIP/index remains untouched; changes are isolated.
