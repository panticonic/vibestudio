import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { ExactSnapshotFile } from "@vibestudio/git";

/**
 * Laying resolved template layers down into the one tree a workspace runs from.
 *
 * Ordering is the only precedence there is: layers arrive dependency-first, so
 * a base is placed before whatever extends it. Beyond that, nothing overrides
 * anything — two layers claiming one path is a mistake in the templates rather
 * than a question for a merge policy, and it stops here naming both sides. The
 * alternative, silently letting the later layer win, is how a workspace ends up
 * running a file its author never wrote and cannot find.
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
