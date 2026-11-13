/**
 * Runtime facts the host programs share on celld.
 *
 * - The gateway is an ordinary `fetch()` to `GATEWAY_URL`. The node sends
 *   every outbound request through Vibestudio's egress proxy, which admits a
 *   deployed host program's requests to the gateway origin only.
 * - Loaded code carries a network identity that the node stamps and
 *   authenticates itself (`celld.egressIdentity`); it cannot be set or
 *   removed by the loaded code. A null identity means "no network".
 */

export {
  classSecretName,
  RPC_AUTH_TOKEN,
  RUNTIME_SCRIPT,
  UNIVERSAL_DO_LOADER_SECRET,
} from "../runtimeNames.js";

export interface HostProgramEnv {
  readonly GATEWAY_URL: string;
  readonly WORKERD_LOADER_SECRET: string;
}

/** Fetch a gateway path. `path` must start with `/`. */
export function gatewayFetch(env: HostProgramEnv, path: string, init?: RequestInit) {
  return fetch(new URL(path, env.GATEWAY_URL), init);
}

/** WorkerCode with celld's per-load capability block. */
export type CelldWorkerCode = WorkerLoaderWorkerCode & {
  celld?: { egressIdentity?: string; codegen?: boolean; residency?: boolean };
};

/**
 * Network policy for loaded code: an attributed identity routes it through the
 * node's egress proxy under that identity; no identity denies all network.
 */
export function loadedNetworkPolicy(
  egressIdentity: string | null
): Pick<CelldWorkerCode, "globalOutbound" | "celld"> {
  if (egressIdentity === null) return { globalOutbound: null };
  if (typeof egressIdentity !== "string" || egressIdentity.length === 0)
    throw new Error("Loaded executable has no network identity");
  return { celld: { egressIdentity } };
}
