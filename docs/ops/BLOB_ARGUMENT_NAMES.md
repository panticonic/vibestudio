# Blob argument discovery

Original 0069 content-addressed-citation capture retained correct live putText/getText schemas but empty argumentNames and null signature. The request explicitly asks each call's argument names. Base open-doc-plan transports the real docs fields unchanged; it cannot truthfully reconstruct names from a positional JSON schema.

Inventory: packages/service-schemas/src/blobstore.ts owns all twenty native method contracts; blobstoreService.ts handlers destructure their actual wire argument names/order. serializeMethod projects declared argumentNames, buildCatalog projects them for both service and schema-backed runtime routes, docsService exposes the caller-filtered entry. Workspace provider docs already carry their independently compiled names/signatures; generated ergonomic runtime clients derive method parameter names from their public declarations. No engine/model path owns these Host API metadata fields. No storage, RPC arity, authority or TLS policy changes.

All twenty blob methods now declare their actual native positional names, including optional arguments. No inferred arg1 placeholders or task-ID-specific lookup was added. Tests check exact native handler correspondence and actual public docs.describe results for content storage/recovery. Other Host service contracts without declared parameter names remain an explicit broader inventory item, not a claim of universal catalog completeness. Original failed answer/capture is unchanged.

Actual validation: `vibe-blob-catalog-argument-names-20261125a`, two component tests PASS in 1.36s, 247.8 MiB peak. No runtime build/model/storage operation was executed.
