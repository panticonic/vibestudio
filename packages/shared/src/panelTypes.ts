import * as fs from "fs";
import * as path from "path";

// Re-export types from shared types (canonical definitions)
export type { Panel, PanelSnapshot, PackageManifest } from "./types.js";
export type { ChildSpec } from "@vibestudio/types";

import type { PackageManifest } from "./types.js";
import { sanitizePlacementHint } from "./panel/placement.js";

/**
 * A panel manifest after `loadPanelManifest` validation: `title` is guaranteed
 * to be a non-empty string. Use this return type when callers need a title
 * without re-asserting.
 */
export type LoadedPanelManifest = PackageManifest & { title: string };

/**
 * Load and validate a panel manifest from package.json.
 *
 * The TypeScript type (`PackageManifest`) is shared with workers, so all fields
 * are optional. This loader enforces panel-specific runtime requirements: a
 * `vibestudio` block must exist and `title` must be set. It also merges top-level
 * `dependencies` into the manifest for the panel runtime's downstream use.
 */
export function loadPanelManifest(panelPath: string): LoadedPanelManifest {
  if (!path.isAbsolute(panelPath)) {
    throw new Error(`loadPanelManifest requires absolute path, got relative: ${panelPath}`);
  }
  const packageJsonPath = path.join(panelPath, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in ${panelPath}`);
  }

  const packageContent = fs.readFileSync(packageJsonPath, "utf-8");
  const packageJson = JSON.parse(packageContent) as Record<string, unknown>;

  if (!packageJson["vibestudio"]) {
    throw new Error(`package.json in ${panelPath} must include a 'vibestudio' field`);
  }

  const manifest = packageJson["vibestudio"] as PackageManifest;

  if (!manifest.title) {
    throw new Error("vibestudio.title must be specified in package.json");
  }
  if (manifest.icon !== undefined) {
    if (typeof manifest.icon !== "string" || !manifest.icon.trim()) {
      throw new Error("vibestudio.icon must be a semantic emoji or a relative image path");
    }
    const icon = manifest.icon.trim();
    if (icon.startsWith("./")) {
      const segments = icon.slice(2).split("/");
      const validAssetPath =
        icon.length <= 256 &&
        !icon.includes("\\") &&
        segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
        /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/iu.test(icon);
      if (!validAssetPath) {
        throw new Error(
          "vibestudio.icon image paths must start with ./, stay inside the unit, and name a supported image"
        );
      }
    } else if (icon.length > 16) {
      throw new Error(
        "vibestudio.icon emoji must be at most 16 UTF-16 code units; use ./path/to/icon.svg for an image"
      );
    }
    manifest.icon = icon;
  }

  // Validate the placement hint block, if declared.
  const placement = sanitizePlacementHint(manifest.placement);
  if (placement) {
    manifest.placement = placement;
  } else {
    delete manifest.placement;
  }

  // Merge package.json dependencies with vibestudio.dependencies
  const pkgDeps = packageJson["dependencies"] as Record<string, string> | undefined;
  if (pkgDeps) {
    manifest.dependencies = {
      ...manifest.dependencies,
      ...pkgDeps,
    };
  }

  // Title is guaranteed by the check above; the cast narrows the type.
  return manifest as LoadedPanelManifest;
}

export interface PanelBuildResult {
  success: boolean;
  bundlePath?: string;
  htmlPath?: string;
  error?: string;
}

export type PanelEventPayload =
  | { type: "child-creation-error"; url: string; error: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };

// Re-export accessor functions for panel state
export {
  getCurrentSnapshot,
  getPanelSource,
  getPanelOptions,
  getPanelEnv,
  getPanelContextId,
  getPanelRef,
  getBrowserResolvedUrl,
  getPanelStateArgs,
  updatePanelNavigationState,
  createSnapshot,
} from "./panel/accessors.js";
