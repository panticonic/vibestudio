import { describe, expect, it } from "vitest";
import {
  PANEL_HOST_PROTOCOL_VERSION,
  PanelHostApplyResultSchema,
  PanelHostDesiredSnapshotSchema,
  PanelHostEffectResultSchema,
  PanelHostHandshakeResultSchema,
  PanelHostObservedSnapshotSchema,
  type DesiredPanelSurface,
  type PanelHostDesiredSnapshot,
  type PanelHostEffect,
  type PanelHostHandshake,
} from "./index.js";
import { InMemoryPanelHostAdapter, type ReferencePanelHostProfile } from "./testing.js";

const PROFILES: readonly ReferencePanelHostProfile[] = ["electron", "react-native", "headless"];

function connect(adapter: InMemoryPanelHostAdapter, identity = "sealed:workspace:shell") {
  const result = adapter.connect({
    sealedLaunchIdentity: identity,
    supportedProtocolVersions: [PANEL_HOST_PROTOCOL_VERSION],
  });
  PanelHostHandshakeResultSchema.parse(result);
  if (!result.accepted) throw new Error(`reference adapter rejected protocol: ${result.reason}`);
  return result.handshake;
}

function surface(
  surfaceId: string,
  partial: Partial<DesiredPanelSurface> = {}
): DesiredPanelSurface {
  return {
    surfaceId,
    materialization: {
      runtimeEntityId: `entity:${surfaceId}`,
      leaseConnectionId: `lease:${surfaceId}`,
    },
    visible: true,
    focused: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    retention: "reclaimable",
    ...partial,
  };
}

function desired(
  handshake: PanelHostHandshake,
  revision: number,
  surfaces: readonly DesiredPanelSurface[]
): PanelHostDesiredSnapshot {
  return {
    protocolVersion: PANEL_HOST_PROTOCOL_VERSION,
    hostGeneration: handshake.hostGeneration,
    shellGeneration: handshake.shellGeneration,
    revision,
    surfaces: [...surfaces],
  };
}

describe.each(PROFILES)("%s panel-host adapter conformance", (profile) => {
  it("converges complete snapshots and treats exact replay as idempotent", () => {
    const adapter = new InMemoryPanelHostAdapter(profile);
    const handshake = connect(adapter);
    const snapshot = desired(handshake, 1, [surface("a", { focused: true }), surface("b")]);

    const first = adapter.applyDesired(snapshot);
    const replay = adapter.applyDesired(snapshot);

    expect(first).toMatchObject({ accepted: true });
    PanelHostApplyResultSchema.parse(first);
    PanelHostObservedSnapshotSchema.parse(adapter.observation());
    expect(replay).toEqual(first);
    expect(adapter.operationCounts()).toEqual({ create: 2, destroy: 0, effect: 0, update: 0 });
  });

  it("destroys omitted surfaces and updates retained surfaces in place", () => {
    const adapter = new InMemoryPanelHostAdapter(profile);
    const handshake = connect(adapter);
    adapter.applyDesired(desired(handshake, 1, [surface("a"), surface("b")]));

    const result = adapter.applyDesired(
      desired(handshake, 2, [surface("b", { focused: true, retention: "retain" })])
    );

    expect(result).toMatchObject({
      accepted: true,
      observation: { desiredRevision: 2, surfaces: [{ surfaceId: "b", focused: true }] },
    });
    expect(adapter.operationCounts()).toEqual({ create: 2, destroy: 1, effect: 0, update: 1 });
  });

  it("recreates a crashed native surface from the same desired revision", () => {
    const adapter = new InMemoryPanelHostAdapter(profile);
    const handshake = connect(adapter);
    const snapshot = desired(handshake, 1, [surface("a")]);
    adapter.applyDesired(snapshot);
    const before = adapter.observation().surfaces[0];

    adapter.crash("a", "renderer-gone");
    expect(adapter.observation().surfaces[0]).toMatchObject({
      surfaceId: "a",
      state: "crashed",
      lastCrash: { reason: "renderer-gone" },
    });
    adapter.applyDesired(snapshot);

    const after = adapter.observation().surfaces[0];
    expect(after).toMatchObject({ surfaceId: "a", state: "ready" });
    expect(after).not.toEqual(before);
    expect(adapter.operationCounts().create).toBe(2);
  });

  it("fences stale renderer generations, revisions, and same-revision drift", () => {
    const adapter = new InMemoryPanelHostAdapter(profile);
    const first = connect(adapter, "sealed:first");
    adapter.applyDesired(desired(first, 2, [surface("a")]));

    expect(adapter.applyDesired(desired(first, 1, [surface("a")]))).toEqual({
      accepted: false,
      reason: "stale-revision",
    });
    expect(
      adapter.applyDesired({
        ...desired(first, 3, [surface("a")]),
        hostGeneration: "host:foreign",
      })
    ).toEqual({ accepted: false, reason: "foreign-host-generation" });
    expect(adapter.applyDesired(desired(first, 2, [surface("a", { visible: false })]))).toEqual({
      accepted: false,
      reason: "revision-conflict",
    });

    const second = connect(adapter, "sealed:second");
    expect(adapter.applyDesired(desired(first, 3, [surface("old")]))).toEqual({
      accepted: false,
      reason: "stale-shell-generation",
    });
    expect(adapter.applyDesired(desired(second, 1, [surface("new")]))).toMatchObject({
      accepted: true,
      observation: { shellGeneration: second.shellGeneration, surfaces: [{ surfaceId: "new" }] },
    });
  });

  it("tears down an unclaimed disconnected shell but lets a new generation converge first", () => {
    const adapter = new InMemoryPanelHostAdapter(profile, { retentionTimeoutMs: 100 });
    const first = connect(adapter);
    adapter.applyDesired(desired(first, 1, [surface("a")]));
    adapter.disconnect(first.shellGeneration, 10);
    adapter.expireDisconnectedShell(109);
    expect(adapter.observation().surfaces).toHaveLength(1);

    const second = connect(adapter);
    adapter.applyDesired(desired(second, 1, [surface("a")]));
    adapter.expireDisconnectedShell(1_000);
    expect(adapter.observation().surfaces).toHaveLength(1);

    adapter.disconnect(second.shellGeneration, 1_000);
    adapter.expireDisconnectedShell(1_100);
    expect(adapter.observation().surfaces).toEqual([]);
  });

  it("does not let an unclaimed replacement handshake cancel pending teardown", () => {
    const adapter = new InMemoryPanelHostAdapter(profile, { retentionTimeoutMs: 100 });
    const first = connect(adapter);
    adapter.applyDesired(desired(first, 1, [surface("a")]));
    adapter.disconnect(first.shellGeneration, 10);

    connect(adapter, "sealed:replacement-without-state");
    adapter.expireDisconnectedShell(110);

    expect(adapter.observation().surfaces).toEqual([]);
  });
});

describe("panel-host negotiation and effects", () => {
  it("exports strict runtime schemas for every transport envelope", () => {
    const adapter = new InMemoryPanelHostAdapter("electron");
    const handshake = connect(adapter);
    const snapshot = desired(handshake, 1, [surface("a")]);

    expect(PanelHostDesiredSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      PanelHostDesiredSnapshotSchema.safeParse({ ...snapshot, unexpectedProductState: true })
        .success
    ).toBe(false);
    expect(PanelHostDesiredSnapshotSchema.safeParse({ ...snapshot, revision: -1 }).success).toBe(
      false
    );
    expect(
      PanelHostDesiredSnapshotSchema.safeParse(
        desired(handshake, 1, [surface("a", { bounds: { x: 0, y: 0, width: -1, height: 10 } })])
      ).success
    ).toBe(false);
  });

  it("rejects unsupported protocol negotiation without minting a shell generation", () => {
    const adapter = new InMemoryPanelHostAdapter("electron");
    expect(
      adapter.connect({ sealedLaunchIdentity: "sealed", supportedProtocolVersions: [] })
    ).toEqual({ accepted: false, reason: "unsupported-protocol" });
  });

  it("deduplicates exact effects and rejects request-id substitution", () => {
    const adapter = new InMemoryPanelHostAdapter("electron");
    const handshake = connect(adapter);
    adapter.applyDesired(desired(handshake, 1, [surface("a")]));
    const request = effectRequest(handshake, "effect:1", "a", { kind: "print" });

    const first = adapter.executeEffect(request);
    PanelHostEffectResultSchema.parse(first);
    expect(first).toMatchObject({ accepted: true, replayed: false });
    expect(adapter.executeEffect(request)).toMatchObject({ accepted: true, replayed: true });
    expect(
      adapter.executeEffect(
        effectRequest(handshake, "effect:1", "a", { kind: "find", query: "different" })
      )
    ).toEqual({ accepted: false, reason: "request-conflict" });
    expect(adapter.operationCounts().effect).toBe(1);
  });

  it("rejects effects and desired fields absent from negotiated endowments", () => {
    const adapter = new InMemoryPanelHostAdapter("react-native");
    const handshake = connect(adapter);
    adapter.applyDesired(desired(handshake, 1, [surface("a")]));

    expect(
      adapter.executeEffect(effectRequest(handshake, "effect:1", "a", { kind: "print" }))
    ).toEqual({ accepted: false, reason: "unsupported-endowment" });
    expect(
      adapter.applyDesired(
        desired(handshake, 2, [
          surface("a", { sessionData: { revision: 1, partition: "persist:ctx" } }),
        ])
      )
    ).toEqual({ accepted: false, reason: "unsupported-endowment" });
  });

  it("reports native navigation as an observation rather than a second desired-state channel", () => {
    const adapter = new InMemoryPanelHostAdapter("headless");
    const handshake = connect(adapter);
    adapter.applyDesired(
      desired(handshake, 1, [
        surface("a", { navigation: { revision: 1, url: "https://example.test/" } }),
      ])
    );

    adapter.observeNavigation("a", "https://example.test/next");
    expect(adapter.observation().surfaces[0]).toMatchObject({
      surfaceId: "a",
      state: "ready",
      navigationUrl: "https://example.test/next",
    });

    adapter.applyDesired(
      desired(handshake, 1, [
        surface("a", { navigation: { revision: 1, url: "https://example.test/" } }),
      ])
    );
    expect(adapter.observation().surfaces[0]).toMatchObject({
      navigationUrl: "https://example.test/",
    });
  });
});

function effectRequest(
  handshake: PanelHostHandshake,
  requestId: string,
  surfaceId: string,
  effect: PanelHostEffect
) {
  return {
    protocolVersion: PANEL_HOST_PROTOCOL_VERSION,
    hostGeneration: handshake.hostGeneration,
    shellGeneration: handshake.shellGeneration,
    requestId,
    surfaceId,
    effect,
  } as const;
}
