/**
 * Bare `crypto` → `node:crypto` shim (optional / belt-and-suspenders).
 *
 * NOTE: the worker build pipeline already shims bare `crypto` for ALL workers
 * via `createCryptoShimPlugin` (see buildWorker), so terminal workers do not
 * need this. Kept only as a standalone, reusable shim; not wired into the
 * terminal-worker build and not part of the package's public exports.
 */
import nodeCrypto from "node:crypto";
export * from "node:crypto";
export default nodeCrypto;
