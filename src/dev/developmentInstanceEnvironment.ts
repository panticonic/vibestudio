import { WORKSPACE_SOURCES_ENV } from "@vibestudio/workspace/workspaceSources";
import {
  DEFAULT_WORKSPACE_TEMPLATES_ENV,
  INITIAL_WORKSPACE_TEMPLATE_ENV,
  type DefaultWorkspaceTemplates,
} from "@vibestudio/workspace/templateRelease";

export interface DevelopmentTemplateEnvironmentSelection {
  pins: DefaultWorkspaceTemplates;
  checkouts: Record<string, string> & Record<keyof DefaultWorkspaceTemplates, string>;
  sourcePins?: Record<string, import("@vibestudio/workspace-contracts/types").WorkspaceTemplatePin>;
  sources?: ReadonlyArray<{ id: string }>;
}

/** Closed developer launch environment: ambient Base selectors never survive. */
export function developmentInstanceEnvironment(input: {
  parent: NodeJS.ProcessEnv;
  repoRoot: string;
  instanceRoot: string;
  instanceId: string;
  sourceCoupled: boolean;
  /** True when the instance root is a temporary directory removed on exit. */
  disposable: boolean;
  defaultTemplates?: DevelopmentTemplateEnvironmentSelection;
  initialWorkspaceTemplate?: import("@vibestudio/workspace-contracts/types").WorkspaceTemplatePin;
  templates?: ReadonlyArray<import("@vibestudio/workspace/workspaceSources").WorkspaceSource>;
}): NodeJS.ProcessEnv {
  const env = { ...input.parent };
  const selectedTemplates = input.defaultTemplates;
  const defaultSources = selectedTemplates
    ? selectedTemplates.sources && selectedTemplates.sourcePins
      ? selectedTemplates.sources.map(({ id }) => ({
          pin: selectedTemplates.sourcePins![id]!,
          checkout: selectedTemplates.checkouts[id],
        }))
      : (Object.keys(selectedTemplates.pins) as Array<keyof DefaultWorkspaceTemplates>).map(
          (name) => ({
            pin: selectedTemplates.pins[name],
            checkout: selectedTemplates.checkouts[name],
          })
        )
    : [];
  delete env[DEFAULT_WORKSPACE_TEMPLATES_ENV];
  delete env[INITIAL_WORKSPACE_TEMPLATE_ENV];
  delete env[WORKSPACE_SOURCES_ENV];
  Object.assign(env, {
    NODE_ENV: "development",
    VIBESTUDIO_APP_ROOT: input.repoRoot,
    VIBESTUDIO_INSTANCE_ROOT: input.instanceRoot,
    VIBESTUDIO_INSTANCE: input.instanceId,
    VIBESTUDIO_SOURCE_INSTANCE: input.sourceCoupled ? "1" : "0",
    // A disposable instance root is deleted when the supervisor exits, so
    // nothing it started may be left running behind an interactive prompt.
    VIBESTUDIO_INSTANCE_LIFECYCLE: input.disposable ? "ephemeral" : "persistent",
    ...(selectedTemplates || input.templates?.length
      ? {
          [WORKSPACE_SOURCES_ENV]: JSON.stringify(
            [...defaultSources, ...(input.templates ?? [])].map((source) => ({
              pin: source.pin,
              checkout: source.checkout,
              ...("review" in source && source.review ? { review: source.review } : {}),
            }))
          ),
        }
      : {}),
    ...(selectedTemplates
      ? {
          [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(selectedTemplates.pins),
          [INITIAL_WORKSPACE_TEMPLATE_ENV]: JSON.stringify(selectedTemplates.pins.system),
        }
      : {}),
  });
  if (input.initialWorkspaceTemplate) {
    env[INITIAL_WORKSPACE_TEMPLATE_ENV] = JSON.stringify(input.initialWorkspaceTemplate);
  }
  return env;
}
