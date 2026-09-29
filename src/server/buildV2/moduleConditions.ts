import type { LibraryBuildTarget } from "@vibestudio/service-schemas/build";
import type { GraphNode } from "./packageGraph.js";

export const PANEL_CONDITIONS = ["vibestudio-panel", "import", "default"] as const;
export const WEBSITE_CONDITIONS = ["browser", "import", "default"] as const;
export const WORKER_CONDITIONS = ["worker", "workerd", "import", "default"] as const;
export const EXTENSION_CONDITIONS = ["import", "default"] as const;
export const NODE_CONDITIONS = ["node", "import", "default"] as const;

export function conditionsForLibraryTarget(target: LibraryBuildTarget): readonly string[] {
  return target === "panel" ? PANEL_CONDITIONS : WORKER_CONDITIONS;
}

export function conditionsForRuntimeUnit(node: GraphNode): readonly string[] {
  switch (node.kind) {
    case "panel":
      return PANEL_CONDITIONS;
    case "worker":
      return WORKER_CONDITIONS;
    case "extension":
      return EXTENSION_CONDITIONS;
    case "app":
      switch (node.manifest.app?.target) {
        case "terminal":
          return NODE_CONDITIONS;
        case "react-native":
          return ["react-native", "import", "default"];
        default:
          return PANEL_CONDITIONS;
      }
    default:
      throw new Error(`${node.kind} has no standalone execution conditions`);
  }
}
