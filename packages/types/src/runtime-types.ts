/**
 * Runtime Types - Core type definitions used by the app from @workspace/runtime.
 *
 * eventSchemas is typed as `unknown` here to avoid a zod dependency.
 * The app never uses this field directly.
 */

/**
 * Layout placement hint for a panel. Declared statically in a panel's manifest
 * (`PackageManifest.placement`) or per-call (`CreateChildOptions.placement`,
 * which wins). The shell's layout engine consumes the server-resolved value.
 */
export interface PanelPlacementHint {
  /** How the panel wants to be placed relative to its parent. Default "side". */
  disposition?: "side" | "replace" | "split-below";
  /** Preferred column width in px. */
  preferredWidth?: number;
  /** Minimum column width in px. */
  minWidth?: number;
}

export interface CreateChildOptions {
  name?: string;
  env?: Record<string, string>;
  /** Git branch, tag, or commit to load for this panel source. */
  ref?: string;
  /** Typed as unknown to avoid zod dependency. At runtime this is EventSchemaMap (Record<string, ZodType>). */
  eventSchemas?: unknown;
  focus?: boolean;
  contextId?: string;
  /** Per-call layout placement override; wins over the manifest's `placement`. */
  placement?: PanelPlacementHint;
}

export interface ChildCreationResult {
  id: string;
}

export interface ChildSpec {
  name?: string;
  env?: Record<string, string>;
  source: string;
  eventSchemas?: unknown;
}
