// ABI v3 separates host-owned provider contracts from the flat public
// extension method surface and includes provider declarations in ready/build
// metadata. Older bundles are intentionally rebuilt; there is no flat-method
// compatibility route for provider operations.
export const EXTENSION_RUNTIME_ABI_VERSION = "3";
