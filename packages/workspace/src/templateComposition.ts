import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { ExactSnapshotFile } from "@vibestudio/git";

/**
 * Laying resolved template layers down into the one tree a workspace runs from.
 *
 * The caller resolves explicit whole-unit ownership before supplying files.
 * Remaining path collisions indicate inconsistent ownership and are rejected;
 * file ordering never silently overrides source.
 */

export interface TemplateLayer {
  /** Which template these files came from, for diagnostics. */
  label: string;
  files: readonly ExactSnapshotFile[];
  readFile(path: string): Uint8Array | null;
}

export interface ComposedTemplateTree {
  files: ExactSnapshotFile[];
  readFile(path: string): Uint8Array | null;
}

export interface ComposeTemplateLayersInput {
  /** Dependency-first: every layer precedes the layers built on it. */
  layers: readonly TemplateLayer[];
  /**
   * Paths the composer must not take from any layer.
   *
   * Every template carries its own source manifest, so that one path is present
   * in each layer and is not a collision — it is the one thing composition has
   * to decide rather than copy. The caller supplies the composed manifest, and
   * naming its path here keeps this function from having an opinion about it.
   */
  composedPaths?: readonly string[];
}

/** Place dependency-first layers into one tree, refusing any contested path. */
export function composeTemplateLayers(input: ComposeTemplateLayersInput): ComposedTemplateTree {
  const composed = new Set(input.composedPaths ?? []);
  const placed = new Map<string, { layer: TemplateLayer; file: ExactSnapshotFile }>();
  for (const layer of input.layers) {
    for (const file of layer.files) {
      if (composed.has(file.path)) continue;
      const existing = placed.get(file.path);
      if (existing) {
        throw new Error(
          `Template composition maps ${file.path} from both ${existing.layer.label} and ` +
            `${layer.label}; a dependency's paths belong to it alone`
        );
      }
      placed.set(file.path, { layer, file });
    }
  }
  const files = [...placed.values()]
    .map(({ file }) => file)
    .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  return {
    files,
    readFile(path) {
      return placed.get(path)?.layer.readFile(path) ?? null;
    },
  };
}
