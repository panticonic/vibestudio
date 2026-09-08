import type { DevelopmentBaseSelection } from "./developmentBaseSelection.js";
import {
  DEFAULT_WORKSPACE_TEMPLATES_ENV,
  INITIAL_WORKSPACE_TEMPLATE_ENV,
} from "@vibestudio/workspace/baseTemplateRelease";
import { WORKSPACE_SOURCES_ENV } from "@vibestudio/workspace/workspaceSources";
import {
  EPHEMERAL_WORKSPACE_ARG,
  RESUME_EPHEMERAL_WORKSPACE_ARG,
} from "@vibestudio/workspace-contracts/ephemeral";

const DEVELOPMENT_ONLY_ARGUMENTS = new Set([
  "--ephemeral",
  EPHEMERAL_WORKSPACE_ARG,
  RESUME_EPHEMERAL_WORKSPACE_ARG,
  "--instance",
  "--base-checkout",
  "--workspace-checkout",
  "--production-base",
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
  distributions?: DevelopmentBaseSelection;
  bootstrapSystem?: boolean;
  templates?: ReadonlyArray<{ pin: unknown; checkout: string }>;
}): NodeJS.ProcessEnv {
  const env = { ...input.parent };
  const distributions = input.distributions;
  const distributionSources = distributions
    ? (["base", "personal", "system"] as const).map((name) => ({
        pin: distributions.pins[name],
        checkout: distributions.checkouts[name],
      }))
    : [];
  for (const key of [
    "VIBESTUDIO_INSTANCE_ROOT",
    "VIBESTUDIO_INSTANCE",
    "VIBESTUDIO_SOURCE_INSTANCE",
    "VIBESTUDIO_DEV_ROOT_TEMPLATE",
    "VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT",
    "VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK",
    DEFAULT_WORKSPACE_TEMPLATES_ENV,
    INITIAL_WORKSPACE_TEMPLATE_ENV,
    WORKSPACE_SOURCES_ENV,
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: "production",
    VIBESTUDIO_APP_ROOT: input.repoRoot,
    ...(distributions || input.templates?.length
      ? {
          [WORKSPACE_SOURCES_ENV]: JSON.stringify(
            [...distributionSources, ...(input.templates ?? [])].map(({ pin, checkout }) => ({
              pin,
              checkout,
            }))
          ),
        }
      : {}),
    ...(distributions
      ? {
          [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(distributions.pins),
          ...(input.bootstrapSystem
            ? {
                [INITIAL_WORKSPACE_TEMPLATE_ENV]: JSON.stringify(distributions.pins.system),
              }
            : {}),
        }
      : {}),
  });
  return env;
}
