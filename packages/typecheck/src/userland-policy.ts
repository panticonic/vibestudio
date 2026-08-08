/**
 * Minimum TypeScript safety policy for publishable userland code.
 *
 * Repository tsconfigs still select their runtime environment (module, lib,
 * JSX, and so on), but they cannot weaken these publication invariants. Keep
 * workspace/tsconfig.json aligned; the parity test pins that projection.
 */
export const USERLAND_TYPECHECK_BASELINE = Object.freeze({
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noPropertyAccessFromIndexSignature: true,
  allowUnusedLabels: false,
  allowUnreachableCode: false,
  forceConsistentCasingInFileNames: true,
}) satisfies Readonly<Record<string, unknown>>;
