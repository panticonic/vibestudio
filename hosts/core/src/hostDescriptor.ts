import {
  capabilitiesForHost,
  currentHostDescriptor,
  type ClientCapability,
  type HostDescriptor,
  type HostKind,
} from "@vibestudio/workspace-contracts/clients";
import { ClientLaunchError } from "./errors.js";

/**
 * The descriptor a host sends the server: this build's runtimes and ABI, with
 * the capabilities the concrete host actually implements. The catalog says
 * which a host of this kind could implement; `implemented` says which this
 * binary does. Claiming one the catalog does not list for this host kind is a
 * host bug, reported rather than dropped.
 */
export function buildHostDescriptor(input: {
  host: HostKind;
  hostVersion: string;
  implemented: Iterable<ClientCapability>;
}): HostDescriptor {
  const base = currentHostDescriptor(input.host, input.hostVersion);
  const possible = new Set<ClientCapability>(capabilitiesForHost(input.host));
  const implemented = new Set(input.implemented);
  for (const capability of implemented) {
    if (!possible.has(capability)) {
      throw new ClientLaunchError(
        "invalid-host-descriptor",
        `The ${input.host} host cannot implement capability "${capability}".`
      );
    }
  }
  return { ...base, capabilities: base.capabilities.filter((c) => implemented.has(c)) };
}
