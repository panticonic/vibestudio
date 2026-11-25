/** Optional owner constraint for one Host process; never a profile-wide default. */
export const HOSTED_MODEL_ROUTE_ENV = "VIBESTUDIO_HOSTED_MODEL_ROUTE";
export interface HostedModelRoute {
  primary: string;
  fallback: string | null;
}

export function readHostedModelRoute(
  env: NodeJS.ProcessEnv = process.env
): HostedModelRoute | null {
  const raw = env[HOSTED_MODEL_ROUTE_ENV];
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${HOSTED_MODEL_ROUTE_ENV} must be a JSON model route`, { cause });
  }
  const canonical = (model: unknown): model is string =>
    typeof model === "string" && /^[^:\s]+:[^\s]+$/u.test(model);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "primary" && key !== "fallback") ||
    !("primary" in value) ||
    !canonical(value.primary) ||
    !("fallback" in value) ||
    (value.fallback !== null && !canonical(value.fallback))
  ) {
    throw new Error(
      `${HOSTED_MODEL_ROUTE_ENV} requires canonical primary and nullable fallback model refs`
    );
  }
  return Object.freeze({ primary: value.primary, fallback: value.fallback });
}

export function hostedModelAllowed(route: HostedModelRoute | null, model: string): boolean {
  return !route || model === route.primary || model === route.fallback;
}

export function assertHostedModelAllowed(route: HostedModelRoute | null, model: string): void {
  if (!hostedModelAllowed(route, model))
    throw new Error(`Model ${model} is outside this Host owner's configured hosted-model route`);
}
