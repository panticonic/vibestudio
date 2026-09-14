import type { DevelopmentTemplateSet } from "./developmentTemplateSet.js";
import {
  DEFAULT_WORKSPACE_TEMPLATES_ENV,
  INITIAL_WORKSPACE_TEMPLATE_ENV,
} from "@vibestudio/workspace/templateRelease";
import { WORKSPACE_SOURCES_ENV } from "@vibestudio/workspace/workspaceSources";

const DEVELOPMENT_ONLY_ARGUMENTS = new Set([
  "--ephemeral",
  "--instance",
  "--template-checkouts",
  "--workspace-checkout",
  "--production-templates",
  "--dev-iroh-remote",
]);

export function assertProductDesktopArguments(argv: readonly string[]): void {
  for (const arg of argv) {
    const name = arg.split("=", 1)[0]!;
    if (DEVELOPMENT_ONLY_ARGUMENTS.has(name)) {
      throw new Error(
        `${name} is a developer-instance option and is not supported by pnpm start; use pnpm dev or pnpm server:live`
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
export function productDesktopEnvironment(input: {
  parent: NodeJS.ProcessEnv;
  repoRoot: string;
  defaultTemplates?: DevelopmentTemplateSet;
  bootstrapSystem?: boolean;
  templates?: ReadonlyArray<{ pin: unknown; checkout: string }>;
}): NodeJS.ProcessEnv {
  const env = { ...input.parent };
  const defaultTemplates = input.defaultTemplates;
  const defaultSources = defaultTemplates
    ? defaultTemplates.sources.map(({ id }) => ({
        pin: defaultTemplates.sourcePins[id]!,
        checkout: defaultTemplates.checkouts[id],
      }))
    : [];
  for (const key of [
    "VIBESTUDIO_INSTANCE_ROOT",
    "VIBESTUDIO_INSTANCE",
    "VIBESTUDIO_SOURCE_INSTANCE",
    DEFAULT_WORKSPACE_TEMPLATES_ENV,
    INITIAL_WORKSPACE_TEMPLATE_ENV,
    WORKSPACE_SOURCES_ENV,
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: "production",
    VIBESTUDIO_APP_ROOT: input.repoRoot,
    ...(defaultTemplates || input.templates?.length
      ? {
          [WORKSPACE_SOURCES_ENV]: JSON.stringify(
            [...defaultSources, ...(input.templates ?? [])].map(({ pin, checkout }) => ({
              pin,
              checkout,
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
