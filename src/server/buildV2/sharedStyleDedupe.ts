import type { Plugin } from "esbuild";

const EMPTY_SHARED_STYLE_NAMESPACE = "vibestudio-covered-shared-style";

/**
 * Keep framework base styles in the adapter-owned shared artifact even when a
 * panel or one of its packages imports the same stylesheet for standalone use.
 */
export function createSharedStyleDedupePlugin(
  sharedStyles: readonly string[]
): Plugin {
  const covered = new Set(sharedStyles);

  return {
    name: "vibestudio-shared-style-dedupe",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // The adapter's canonical stylesheet uses CSS @import rules. Packages
        // use JavaScript imports so they remain valid when built standalone.
        // Suppress only that second, already-covered path.
        if (!covered.has(args.path) || args.kind !== "import-statement") return;
        return { path: args.path, namespace: EMPTY_SHARED_STYLE_NAMESPACE };
      });
      build.onLoad(
        { filter: /.*/, namespace: EMPTY_SHARED_STYLE_NAMESPACE },
        () => ({ contents: "", loader: "css" })
      );
    },
  };
}
