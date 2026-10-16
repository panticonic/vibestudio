import * as path from "node:path";
import {
  ClientArtifactCache,
  ClientLauncher,
  buildHostDescriptor,
  principalGrantsOverCall,
  type Call,
  type PrincipalGrants,
} from "@vibestudio/client-host-core";
import { NodeArtifactStore } from "@vibestudio/client-host-core/node";
import { gatewayMethods } from "@vibestudio/service-schemas/gateway";
import {
  createTypedServiceClient,
  qualifyServiceMethod,
} from "@vibestudio/shared/typedServiceClient";
import type { ClientCapability, HostDescriptor } from "@vibestudio/workspace-contracts/clients";
import { cliConfigRoot } from "../../src/cli/configPaths.js";
import type { RpcClient } from "../../src/cli/rpcClient.js";

/**
 * Capabilities this terminal host implements. `integration.install` is a
 * person-initiated CLI command here (`vibestudio clients link`), not a module
 * a client can call, so it is not claimed.
 */
export const TERMINAL_HOST_CAPABILITIES: readonly ClientCapability[] = [
  "device-session",
  "terminal-app-hosting",
  "approval-surface",
  "hub-control",
  "notifications",
  "local-files",
  "clipboard",
  "open-external",
];

export function terminalHostDescriptor(hostVersion: string): HostDescriptor {
  return buildHostDescriptor({
    host: "terminal",
    hostVersion,
    implemented: TERMINAL_HOST_CAPABILITIES,
  });
}

/** Verified client artifacts, under the CLI's state directory. */
export function clientCachePath(root = cliConfigRoot()): string {
  return path.join(root, "client-cache");
}

/** One RPC call on a device shell session, in the core's `Call` shape. */
export function deviceCall(device: Pick<RpcClient, "call">): Call {
  return (service, method, args) => device.call(qualifyServiceMethod(service, method), args);
}

export interface TerminalClientDelivery {
  launcher: ClientLauncher;
  cache: ClientArtifactCache;
  grants: PrincipalGrants;
  descriptor: HostDescriptor;
}

/**
 * The launch pipeline over this device's System session: `clients.launch`,
 * artifacts fetched through `gateway.fetch` into the verified cache, and the
 * principal grant for the exact build. `companions` are the sessions of
 * workspaces started together with System, whose creation reviews are asked
 * in the same gate.
 */
export function createTerminalDelivery(input: {
  device: Pick<RpcClient, "call" | "stream">;
  companions?: readonly Pick<RpcClient, "call">[];
  hostVersion: string;
  cacheRoot?: string;
}): TerminalClientDelivery {
  const call = deviceCall(input.device);
  const gateway = createTypedServiceClient("gateway", gatewayMethods, (service, method, args) =>
    input.device.stream("main", qualifyServiceMethod(service, method), args)
  );
  const cache = new ClientArtifactCache(
    new NodeArtifactStore(input.cacheRoot ?? clientCachePath()),
    (route) => gateway.fetch({ path: route, method: "GET" })
  );
  const grants = principalGrantsOverCall(call);
  const descriptor = terminalHostDescriptor(input.hostVersion);
  const launcher = new ClientLauncher({
    call,
    descriptor,
    cache,
    grants,
    companions: (input.companions ?? []).map(deviceCall),
  });
  return { launcher, cache, grants, descriptor };
}
