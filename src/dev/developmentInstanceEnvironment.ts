import { WORKSPACE_SOURCES_ENV } from "@vibestudio/workspace/workspaceSources";
import {
  DEFAULT_WORKSPACE_TEMPLATES_ENV,
  INITIAL_WORKSPACE_TEMPLATE_ENV,
  type DefaultWorkspaceTemplates,
} from "@vibestudio/workspace/baseTemplateRelease";

export interface DevelopmentBaseEnvironmentSelection {
  pins: DefaultWorkspaceTemplates;
  checkouts: Record<keyof DefaultWorkspaceTemplates, string>;
  sourceCheckout: string;
  writebackRepositories: readonly string[];
}

/** Closed developer launch environment: ambient Base selectors never survive. */
export function developmentInstanceEnvironment(input: {
  parent: NodeJS.ProcessEnv;
  repoRoot: string;
  instanceRoot: string;
  instanceId: string;
  sourceCoupled: boolean;
  base?: DevelopmentBaseEnvironmentSelection;
  initialWorkspaceTemplate?: import("@vibestudio/workspace-contracts/types").WorkspaceTemplatePin;
  templates?: ReadonlyArray<import("@vibestudio/workspace/workspaceSources").WorkspaceSource>;
}): NodeJS.ProcessEnv {
  const env = { ...input.parent };
  const selectedBase = input.base;
  const baseSources = selectedBase
    ? (Object.keys(selectedBase.pins) as Array<keyof DefaultWorkspaceTemplates>).map((name) => ({
        pin: selectedBase.pins[name],
        checkout: selectedBase.checkouts[name],
      }))
    : [];
  delete env["VIBESTUDIO_DEV_ROOT_TEMPLATE"];
  delete env["VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT"];
  delete env["VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK"];
  delete env[DEFAULT_WORKSPACE_TEMPLATES_ENV];
  delete env[INITIAL_WORKSPACE_TEMPLATE_ENV];
  delete env[WORKSPACE_SOURCES_ENV];
  Object.assign(env, {
    NODE_ENV: "development",
    VIBESTUDIO_APP_ROOT: input.repoRoot,
    VIBESTUDIO_INSTANCE_ROOT: input.instanceRoot,
    VIBESTUDIO_INSTANCE: input.instanceId,
    VIBESTUDIO_SOURCE_INSTANCE: input.sourceCoupled ? "1" : "0",
    ...(selectedBase || input.templates?.length
      ? {
          [WORKSPACE_SOURCES_ENV]: JSON.stringify(
            [...baseSources, ...(input.templates ?? [])].map((source) => ({
              pin: source.pin,
              checkout: source.checkout,
              ...("review" in source && source.review ? { review: source.review } : {}),
            }))
          ),
        }
      : {}),
    ...(selectedBase
      ? {
          [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(selectedBase.pins),
          [INITIAL_WORKSPACE_TEMPLATE_ENV]: JSON.stringify(selectedBase.pins.system),
          ...(input.sourceCoupled
            ? {
                VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK: JSON.stringify({
                  root: selectedBase.sourceCheckout,
                  repositories: selectedBase.writebackRepositories,
                }),
              }
            : {}),
        }
      : {}),
  });
  if (input.initialWorkspaceTemplate) {
    env[INITIAL_WORKSPACE_TEMPLATE_ENV] = JSON.stringify(input.initialWorkspaceTemplate);
  }
  return env;
}
