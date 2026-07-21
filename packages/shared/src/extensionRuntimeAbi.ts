// ABI v4 seals the host-owned childRuntime lifecycle authority into every
// extension build. Older bundles are intentionally rebuilt so cached metadata
// cannot omit the activation handshake authority.
export const EXTENSION_RUNTIME_ABI_VERSION = "4";
