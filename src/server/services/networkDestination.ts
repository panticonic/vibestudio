import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  nonPublic.addSubnet(address, prefix, "ipv4");
// Admit ordinary global unicast IPv6, excluding special-use and transition
// ranges. IPv4-mapped IPv6 is checked against the IPv4 rules by BlockList.
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  nonPublic.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const mappedV4 = new BlockList();
mappedV4.addSubnet("::ffff:0:0", 96, "ipv6");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

export class NetworkDestinationDenied extends Error {}

export type NetworkEndpointAuthority =
  | { kind: "public" }
  | { kind: "internal-loopback"; origin: string };

export function networkHostname(hostname: string): string {
  const value =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (!value || value.includes("%")) throw new NetworkDestinationDenied("Invalid network hostname");
  return value.toLowerCase();
}

export function isPublicNetworkAddress(address: string, hostAddresses: readonly string[]): boolean {
  const family = isIP(address);
  if (!family || address.includes("%")) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (nonPublic.check(address, type)) return false;
  if (family === 6 && !globalV6.check(address, type) && !mappedV4.check(address, type))
    return false;
  const host = new BlockList();
  for (const local of hostAddresses) {
    const bare = local.split("%")[0]!;
    const localFamily = isIP(bare);
    if (localFamily) host.addAddress(bare, localFamily === 4 ? "ipv4" : "ipv6");
  }
  return !host.check(address, type);
}

/** A connection consumes this vetted snapshot; it must never resolve again. */
export interface NetworkDestination {
  hostname: string;
  addresses: readonly LookupAddress[];
  lookup: LookupFunction;
}

async function resolveWithDeadline(
  hostname: string,
  resolve: (hostname: string) => Promise<LookupAddress[]>,
  signal: AbortSignal
): Promise<LookupAddress[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  deadline.throwIfAborted();
  return new Promise((accept, reject) => {
    const aborted = () => reject(deadline.reason);
    deadline.addEventListener("abort", aborted, { once: true });
    Promise.resolve()
      .then(() => {
        deadline.throwIfAborted();
        return resolve(hostname);
      })
      .then(accept, reject)
      .finally(() => deadline.removeEventListener("abort", aborted));
  });
}

export async function resolveNetworkDestination(
  target: URL,
  authority: NetworkEndpointAuthority,
  signal: AbortSignal,
  resolve: (hostname: string) => Promise<LookupAddress[]> = (hostname) =>
    lookup(hostname, { all: true }),
  hostAddresses: readonly string[] = Object.values(networkInterfaces()).flatMap(
    (entries) => entries?.map((entry) => entry.address) ?? []
  )
): Promise<NetworkDestination> {
  signal.throwIfAborted();
  const hostname = networkHostname(target.hostname);
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await resolveWithDeadline(hostname, resolve, signal);
  signal.throwIfAborted();
  if (!addresses.length) throw new Error("Network destination has no addresses");
  if (authority.kind === "internal-loopback" && authority.origin !== target.origin) {
    throw new NetworkDestinationDenied("Internal endpoint authority does not match destination");
  }
  // Reject a mixed public/private answer altogether. Picking only its public
  // member would mask a destination change and make retries policy-dependent.
  for (const entry of addresses) {
    if (
      isIP(entry.address) !== entry.family ||
      (authority.kind === "internal-loopback"
        ? !loopback.check(entry.address, entry.family === 4 ? "ipv4" : "ipv6")
        : !isPublicNetworkAddress(entry.address, hostAddresses))
    ) {
      throw new NetworkDestinationDenied(
        "Network destination is outside the authorized address space"
      );
    }
  }
  const pinned = addresses.map((entry) => Object.freeze({ ...entry }));
  return {
    hostname,
    addresses: Object.freeze(pinned),
    lookup: (requestedHostname, options, callback) => {
      let matches = false;
      try {
        matches = networkHostname(requestedHostname) === hostname;
      } catch {
        /* reject below */
      }
      if (signal.aborted || !matches) {
        callback(new Error("Network destination is no longer authorized"), "", 0);
        return;
      }
      const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
      const candidates = family ? pinned.filter((entry) => entry.family === family) : pinned;
      if (!candidates.length) {
        callback(new Error("No authorized address for the requested family"), "", 0);
      } else if (options.all) {
        callback(
          null,
          candidates.map((entry) => ({ ...entry }))
        );
      } else {
        callback(null, candidates[0]!.address, candidates[0]!.family);
      }
    },
  };
}
