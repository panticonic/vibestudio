export interface DevelopmentBaseEnvironmentSelection {
  pin: unknown;
  checkout: string;
  sourceCheckout: string;
}

/** Closed developer launch environment: ambient Base selectors never survive. */
export function developmentInstanceEnvironment(input: {
  parent: NodeJS.ProcessEnv;
  repoRoot: string;
  instanceRoot: string;
  instanceId: string;
  sourceCoupled: boolean;
  base?: DevelopmentBaseEnvironmentSelection;
}): NodeJS.ProcessEnv {
  const env = { ...input.parent };
  delete env["VIBESTUDIO_DEV_ROOT_TEMPLATE"];
  delete env["VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT"];
  delete env["VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK"];
  Object.assign(env, {
    NODE_ENV: "development",
    VIBESTUDIO_APP_ROOT: input.repoRoot,
    VIBESTUDIO_INSTANCE_ROOT: input.instanceRoot,
    VIBESTUDIO_INSTANCE: input.instanceId,
    VIBESTUDIO_SOURCE_INSTANCE: input.sourceCoupled ? "1" : "0",
    ...(input.base
      ? {
          VIBESTUDIO_DEV_ROOT_TEMPLATE: JSON.stringify(input.base.pin),
          VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT: input.base.checkout,
          ...(input.sourceCoupled
            ? { VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK: input.base.sourceCheckout }
            : {}),
        }
      : {}),
  });
  return env;
}
