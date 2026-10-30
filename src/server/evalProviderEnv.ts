import type { WorkspaceProvidersDecl } from "@vibestudio/workspace-contracts/types";

/**
 * Env bindings the manifest's `providers.*` slots become on the internal
 * `EvalDO` class. The EvalDO carries no workspace unit names; it reads these.
 */
export function evalDoProviderEnv(
  providers: WorkspaceProvidersDecl | undefined
): Record<string, string> {
  const env: Record<string, string> = {};
  if (providers?.evalEngine?.source) env["EVAL_ENGINE_SOURCE"] = providers.evalEngine.source.trim();
  if (providers?.evalRuntime?.source)
    env["EVAL_RUNTIME_SOURCE"] = providers.evalRuntime.source.trim();
  if (providers?.cdpClient?.source)
    env["EVAL_CDP_CLIENT_SOURCE"] = providers.cdpClient.source.trim();
  if (providers?.natlang?.source) env["EVAL_NATLANG_SOURCE"] = providers.natlang.source.trim();
  return env;
}
