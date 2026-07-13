import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  gitInteropProviderMethods,
  type GitInteropProviderArgs,
  type GitInteropProviderMethod,
  type GitInteropProviderResult,
} from "@vibestudio/service-schemas/gitInterop";

export interface GitInteropProviderHost {
  invokeProvider(
    ctx: ServiceContext,
    provider: string,
    method: string,
    args: unknown[]
  ): Promise<unknown>;
}

export type GitInteropProviderInvoker = <M extends GitInteropProviderMethod>(
  ctx: ServiceContext,
  method: M,
  args: GitInteropProviderArgs<M>
) => Promise<GitInteropProviderResult<M>>;

/**
 * Build the sole host-to-Git-provider dispatch boundary. Provider selection is
 * resolved by the extension host from the manifest slot, and both sides of the
 * extension transport are checked against the canonical provider schema.
 */
export function createGitInteropProviderInvoker(
  getHost: () => GitInteropProviderHost | null
): GitInteropProviderInvoker {
  return async <M extends GitInteropProviderMethod>(
    ctx: ServiceContext,
    method: M,
    args: GitInteropProviderArgs<M>
  ): Promise<GitInteropProviderResult<M>> => {
    const host = getHost();
    if (!host) {
      throw new Error("Git upstream provider is unavailable: extension host not started");
    }
    const contract = gitInteropProviderMethods[method];
    const parsedArgs = contract.args.safeParse(args);
    if (!parsedArgs.success) {
      throw new Error(
        `Invalid gitInterop provider ${method} arguments: ${parsedArgs.error.message}`
      );
    }
    const result = await host.invokeProvider(
      ctx,
      "gitInterop",
      method,
      parsedArgs.data as unknown[]
    );
    const parsedResult = contract.returns.safeParse(result);
    if (!parsedResult.success) {
      throw new Error(
        `Invalid gitInterop provider ${method} result: ${parsedResult.error.message}`
      );
    }
    return parsedResult.data as GitInteropProviderResult<M>;
  };
}
