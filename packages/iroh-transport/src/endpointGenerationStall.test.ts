/**
 * The reconnect storm's trigger, against the real binding, with no network.
 *
 * A desktop spent seventeen minutes of a CI run cycling its connections
 * because dials kept outliving the per-attempt deadline, and the only way to
 * cancel a timed-out dial is to replace the process endpoint. That was
 * impossible to summon on demand — a healthy machine dials in milliseconds —
 * so the loop had to be reconstructed from timestamps.
 *
 * It is summonable after all. A TCP listener that accepts a connection and
 * then says nothing is relay-shaped enough for the binding to keep waiting on:
 * a dial through it stalls indefinitely rather than failing, which is the one
 * condition the storm needed. These tests use that to hold the real
 * `EndpointGenerationOwner` against a real endpoint in the state the storm
 * found it in, deterministically and in a fraction of a second.
 */

import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  EndpointGenerationOwner,
  type EndpointGenerationInvalidation,
} from "./endpointGeneration.js";
import { loadIrohNodeBinding } from "./nodeBinding.js";
import { createNodeEndpointBinding } from "./nodePhysical.js";
import { IROH_REACH_VERSION, type IrohReach } from "./reach.js";

const UNREACHABLE_PEER = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const servers: net.Server[] = [];
const owners: Array<{ close(): Promise<void> }> = [];

/** A relay-shaped black hole: it accepts, and then it waits with you. */
async function stalledRelay(): Promise<string> {
  const server = net.createServer((socket) => {
    // Holding the socket open is the whole behaviour. Errors are the peer
    // giving up, which is not this fixture's business.
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  return `https://127.0.0.1:${address.port}/`;
}

function reachThrough(relayUrl: string): IrohReach {
  return { endpointId: UNREACHABLE_PEER, relays: [relayUrl], v: IROH_REACH_VERSION };
}

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close().catch(() => undefined)));
  for (const server of servers.splice(0)) server.close();
});

describe("a dial that outlives its deadline, on the real binding", () => {
  it("stalls rather than failing, which is what made the storm possible", async () => {
    // The assumption this rests on, asserted rather than believed: the binding
    // does not reject a dial through an unresponsive relay, so the per-attempt
    // deadline is the only thing that ends it.
    const { SecretKey } = loadIrohNodeBinding();
    const binding = createNodeEndpointBinding({
      secretKey: SecretKey.generate(),
      relayUrls: [await stalledRelay()],
    });
    const endpoint = await binding.bind();
    try {
      const settled = await Promise.race([
        endpoint
          .connect(reachThrough(endpoint.endpointId), "https://127.0.0.1:1/")
          .then(() => "connected" as const)
          .catch(() => "rejected" as const),
        new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 1_500)),
      ]);
      expect(settled).toBe("stalled");
    } finally {
      await endpoint.close().catch(() => undefined);
    }
  }, 20_000);

  it("replaces the generation when nothing is live, and says which dial cost it", async () => {
    const { SecretKey } = loadIrohNodeBinding();
    const relayUrl = await stalledRelay();
    const owner = new EndpointGenerationOwner(
      createNodeEndpointBinding({ secretKey: SecretKey.generate(), relayUrls: [relayUrl] })
    );
    owners.push(owner);
    const invalidations: EndpointGenerationInvalidation[] = [];
    owner.onInvalidation((invalidation) => invalidations.push(invalidation));

    await expect(
      owner.dial({
        reach: reachThrough(relayUrl),
        overallDeadlineMs: 900,
        perAttemptDeadlineMs: 300,
      })
    ).rejects.toThrow(/Unable to reach/u);

    // With no connections to lose, cancelling by replacement is free and the
    // owner still takes it — and the warning can now name the address, which
    // is what the first pass of this diagnosis could not do.
    expect(invalidations.length).toBeGreaterThan(0);
    expect(invalidations[0]).toMatchObject({
      reason: "dial-timeout",
      timedOutDial: { peerEndpointId: UNREACHABLE_PEER, relayUrl, deadlineMs: 300 },
    });
  }, 20_000);

  // What the timeout does when the endpoint *is* holding connections — abandon
  // the attempt rather than take them down — is settled in
  // `endpointGeneration.test.ts` through the public API. Restating it here
  // would mean planting a connection in the owner's private bookkeeping,
  // because a real one needs a working relay and a working relay is the one
  // thing this fixture cannot be.
});
