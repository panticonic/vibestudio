import type { RpcCallOptions } from "@vibestudio/rpc";

import type { RpcCaller } from "@vibestudio/rpc";
import type { RpcMethodMap, RpcMethodArgs, RpcMethodResult } from "./rpcMethods.js";
export type RpcCallerLike = Pick<RpcCaller, "call">;

export type RpcCallOptionsLike = Pick<
  RpcCallOptions,
  "signal" | "timeoutMs" | "destination" | "idempotencyKey"
>;

export interface DORefParam {
  source: string;
  className: string;
  objectKey: string;
}

export type { ResolvedWorkspaceService } from "@vibestudio/workspace-contracts/workspaceConfigSchema";

export interface ResolvedDurableObjectTarget {
  kind: "durable-object";
  source: string;
  className: string;
  objectKey: string;
  targetId: string;
}

export interface DurableObjectServiceClient<M extends RpcMethodMap> {
  resolve(options?: RpcCallOptionsLike): Promise<ResolvedDurableObjectTarget>;
  call<K extends keyof M & string>(
    method: K,
    ...args: RpcMethodArgs<M[K]>
  ): Promise<RpcMethodResult<M[K]>>;
  callWithOptions<K extends keyof M & string>(
    method: K,
    args: RpcMethodArgs<M[K]>,
    options: RpcCallOptionsLike
  ): Promise<RpcMethodResult<M[K]>>;
}

export const GAD_WORKSPACE_SERVICE_PROTOCOL = "vibestudio.gad.workspace.v1";

/** Shared wire contract implemented by the manifest-declared workspace source provider. */
export const VCS_SERVICE_PROTOCOL = "vibestudio.vcs.v1";

/** JSON arrays turn `undefined` into `null`, which changes an omitted optional
 * RPC argument into an explicit (and usually invalid) value. Preserve the
 * JavaScript call contract by removing only omitted trailing arguments before
 * crossing the wire; interior positions remain exact. */
export function omitTrailingUndefined(args: unknown[]): unknown[] {
  let length = args.length;
  while (length > 0 && args[length - 1] === undefined) length -= 1;
  return length === args.length ? args : args.slice(0, length);
}

export function doTargetId(ref: DORefParam): string {
  return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
}

export function parseDoTargetId(targetId: string): DORefParam | null {
  if (!targetId.startsWith("do:")) return null;
  const body = targetId.slice(3);
  const slashIdx = body.indexOf("/");
  const colonAfterSlash = slashIdx >= 0 ? body.indexOf(":", slashIdx) : -1;
  if (colonAfterSlash === -1) return null;
  const source = body.slice(0, colonAfterSlash);
  const rest = body.slice(colonAfterSlash + 1);
  const nextColon = rest.indexOf(":");
  if (nextColon === -1) return null;
  return {
    source,
    className: rest.slice(0, nextColon),
    objectKey: rest.slice(nextColon + 1),
  };
}
