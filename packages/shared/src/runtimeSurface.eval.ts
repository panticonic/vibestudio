/**
 * The eval surface: what an agent `eval` session sees from the EvalDO.
 *
 * `evalImportableSurface` is the portable runtime-instance surface — exactly what
 * `createHostedRuntime` returns and what `import { … } from "@workspace/runtime"`
 * resolves to inside eval. It is now LITERALLY `portableRuntimeSurface` (the
 * single source of truth shared with panel/worker), so eval has the full portable
 * surface including `callMain` and `parent`/`getParent`/`getParentWithContract`.
 *
 * `EVAL_AMBIENT_ONLY` are the eval-only ambient globals injected as free
 * variables, NOT importable. It is the single source of truth for the
 * importValidation `PRE_INJECTED` set. `rpc` is intentionally absent here:
 * imported `rpc` and ambient `rpc` are the same portable client.
 */

import type { RuntimeSurface } from "./runtimeSurface.js";
import { portableExports } from "./runtimeSurface.portable.js";

/**
 * Eval-only ambient globals (free variables), NOT importable. Single source for
 * importValidation `PRE_INJECTED`. Order is not significant.
 */
export const EVAL_AMBIENT_ONLY = [
  "services",
  "scope",
  "scopes",
  "db",
  "ctx",
  "help",
  "chat",
  "agent",
] as const;

export type EvalAmbientOnlyName = (typeof EVAL_AMBIENT_ONLY)[number];

export const evalImportableSurface: RuntimeSurface & { exports: typeof portableExports } = {
  // Reuse the panel target tag for the meta/contract schema union (eval imports
  // the same @workspace/runtime module shape a panel does).
  target: "panel",
  description:
    "Named exports importable from @workspace/runtime inside an agent eval session (the portable WorkspaceRuntime surface).",
  exports: portableExports,
};

/** The importable key set (Object.keys of what createHostedRuntime returns). */
export const EVAL_IMPORTABLE_KEYS = Object.keys(portableExports);
