import type { DevelopmentTemplateSet } from "./developmentTemplateSet.js";
import { developmentTemplateSetSources } from "../../scripts/lib/development-template-set.mjs";
import type { WorkspaceSource } from "@vibestudio/workspace/workspaceSources";
import {
  DEFAULT_WORKSPACE_TEMPLATES_ENV,
  INITIAL_WORKSPACE_TEMPLATE_ENV,
} from "@vibestudio/workspace/templateRelease";
import { WORKSPACE_SOURCES_ENV } from "@vibestudio/workspace/workspaceSources";
import * as path from "node:path";
import { TEMPLATE_REGISTRY_FILE_ENV } from "@vibestudio/service-schemas/templates";

const DEVELOPMENT_ONLY_ARGUMENTS = new Set([
  "--ephemeral",
  "--instance",
  "--template-checkouts",
  "--workspace-checkout",
  "--production-templates",
  "--dev-iroh-remote",
]);

/** What a product launch opens: the desktop app (`pnpm start`) or the terminal browser (`pnpm start:terminal`). */
export type ProductSurface = "desktop" | "terminal";

const PRODUCT_COMMANDS: Record<ProductSurface, { start: string; dev: string }> = {
  desktop: { start: "pnpm start", dev: "pnpm dev" },
  terminal: { start: "pnpm start:terminal", dev: "pnpm dev:terminal" },
};

export function assertProductLaunchArguments(
  argv: readonly string[],
  surface: ProductSurface
): void {
  const { start, dev } = PRODUCT_COMMANDS[surface];
  for (const arg of argv) {
    const name = arg.split("=", 1)[0]!;
    if (DEVELOPMENT_ONLY_ARGUMENTS.has(name)) {
      throw new Error(
        `${name} is a developer-instance option and is not supported by ${start}; use ${dev} or pnpm server:live`
      );
    }
    // The launch owns the build and templates the server runs from, and
    // retires them when the browser quits; a retained server would outlive them.
    if (surface === "terminal" && name === "--keep-server") {
      throw new Error(
        `--keep-server is not supported by ${start}: the server runs this launch's build, which ends with it. ` +
          "Use an installed `vibestudio terminal --keep-server`."
      );
    }
  }
}

/**
 * Build the environment for a source checkout exercising installed-product
 * semantics. Mutable instance routing and ambient Base selectors are removed;
 * the optional Base is only the initial workspace template and exact-byte
 * acquisition source.
 */
export function productLaunchEnvironment(input: {
  parent: NodeJS.ProcessEnv;
  repoRoot: string;
  defaultTemplates?: DevelopmentTemplateSet;
  bootstrapSystem?: boolean;
  templates?: ReadonlyArray<{ pin: unknown; checkout: string; review?: WorkspaceSource["review"] }>;
}): NodeJS.ProcessEnv {
  const env = { ...input.parent };
  const defaultTemplates = input.defaultTemplates;
  const defaultSources = defaultTemplates ? developmentTemplateSetSources(defaultTemplates) : [];
  for (const key of [
    "VIBESTUDIO_INSTANCE_ROOT",
    "VIBESTUDIO_INSTANCE",
    "VIBESTUDIO_SOURCE_INSTANCE",
    DEFAULT_WORKSPACE_TEMPLATES_ENV,
    INITIAL_WORKSPACE_TEMPLATE_ENV,
    WORKSPACE_SOURCES_ENV,
    TEMPLATE_REGISTRY_FILE_ENV,
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: "production",
    VIBESTUDIO_APP_ROOT: input.repoRoot,
    ...(defaultTemplates
      ? { [TEMPLATE_REGISTRY_FILE_ENV]: path.join(input.repoRoot, "templates", "registry.json") }
      : {}),
    ...(defaultTemplates || input.templates?.length
      ? {
          [WORKSPACE_SOURCES_ENV]: JSON.stringify(
            [...defaultSources, ...(input.templates ?? [])].map(({ pin, checkout, review }) => ({
              pin,
              checkout,
              ...(review ? { review } : {}),
            }))
          ),
        }
      : {}),
    ...(defaultTemplates
      ? {
          [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(defaultTemplates.pins),
          ...(input.bootstrapSystem
            ? {
                [INITIAL_WORKSPACE_TEMPLATE_ENV]: JSON.stringify(defaultTemplates.pins.system),
              }
            : {}),
        }
      : {}),
  });
  return env;
}
