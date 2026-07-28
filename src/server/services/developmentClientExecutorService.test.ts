import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { DevelopmentClientExecutorRegistry } from "./developmentClientExecutorService.js";

const DIGEST = "a".repeat(64);
const MAIN = "b".repeat(64);

function caller(runtimeId: string, userId: string, kind: "shell" | "worker" = "shell") {
  return {
    caller: createVerifiedCaller(runtimeId, kind, null, null, { userId, handle: userId }),
  } satisfies ServiceContext;
}

function fixture(isolatedHost?: { instanceId: string; generationId: string }) {
  let now = 1_000;
  const emitted: Array<{ callerId: string; event: string; payload: unknown }> = [];
  const registry = new DevelopmentClientExecutorRegistry({
    now: () => now,
    eventService: {
      emitToCaller(callerId, event, payload) {
        emitted.push({ callerId, event, payload });
        return true;
      },
    },
    ...(isolatedHost ? { isolatedHost } : {}),
  });
  const service = registry.definition();
  const invoke = (ctx: ServiceContext, method: string, args: unknown[]) =>
    service.handler(ctx, method, args);
  return { registry, emitted, invoke, advance: (ms: number) => (now += ms) };
}

async function register(
  f: ReturnType<typeof fixture>,
  runtimeId: string,
  userId = "user:one",
  providerId = runtimeId
) {
  await f.invoke(caller(runtimeId, userId), "register", [
    {
      providerId,
      platform: process.platform,
      arch: process.arch,
      executorDigest: DIGEST,
    },
  ]);
}

describe("DevelopmentClientExecutorRegistry", () => {
  it("admits the authenticated user device without lending it the product-host principal", () => {
    const service = fixture().registry.definition();
    expect(service.authority).toEqual({ principals: ["user"] });
    expect(
      Object.values(service.methods).every(
        (method) => JSON.stringify(method.authority) === JSON.stringify({ principals: ["user"] })
      )
    ).toBe(true);
  });

  it("selects only the initiating authenticated desktop runtime", async () => {
    const f = fixture();
    await register(f, "shell:other");
    await register(f, "shell:initiating");

    expect(
      f.registry.select({
        ownerUserId: "user:one",
        ownerRuntimeId: "shell:initiating",
        platform: process.platform,
        arch: process.arch,
      })
    ).toEqual({
      providerId: "shell:initiating",
      ownerRuntimeId: "shell:initiating",
      ownerUserId: "user:one",
      platform: process.platform,
      arch: process.arch,
      executorDigest: DIGEST,
    });
    expect(
      f.registry.select({
        ownerUserId: "user:one",
        ownerRuntimeId: "shell:missing",
        platform: process.platform,
        arch: process.arch,
      })
    ).toBeNull();
  });

  it("requires both the selected provider receipt and a newly paired child attestation", async () => {
    const f = fixture();
    await register(f, "shell:initiating");
    await register(f, "shell:other");
    const binding = f.registry.select({
      ownerUserId: "user:one",
      ownerRuntimeId: "shell:initiating",
      platform: process.platform,
      arch: process.arch,
    })!;
    const launch = f.registry.launch({
      runId: "run:one",
      binding,
      mainEntryBuildId: MAIN,
      executionDigest: DIGEST,
      recipeId: "recipe:one",
      artifactSource: {
        manifest: [{ path: "dist/main.cjs", integrity: `sha256-${MAIN}`, byteLength: 3 }],
        read: () => Buffer.from("app"),
      },
      pairingDeepLink: "vibestudio://connect?request=opaque",
    });
    const request = f.emitted[0]!.payload as { requestId: string };
    expect(f.emitted[0]).toMatchObject({
      callerId: "shell:initiating",
      event: "development:client-launch-request",
    });

    await expect(
      f.invoke(caller("shell:other", "user:one"), "claim", [{ requestId: request.requestId }])
    ).rejects.toMatchObject({ code: "ENOENT" });
    await f.invoke(caller("shell:initiating", "user:one"), "launched", [
      { requestId: request.requestId, childPid: 1234, ownershipDigest: "c".repeat(64) },
    ]);
    let settled = false;
    void launch.ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await expect(
      f.invoke(caller("shell:child", "user:other"), "attest", [{ requestId: request.requestId }])
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      f.invoke(caller("shell:initiating", "user:one"), "attest", [{ requestId: request.requestId }])
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      f.invoke(caller("worker:child", "user:one", "worker"), "attest", [
        { requestId: request.requestId },
      ])
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      f.invoke(caller("shell:child", "user:one"), "attest", [{ requestId: request.requestId }])
    ).resolves.toEqual({ accepted: true });
    await expect(launch.ready).resolves.toMatchObject({
      requestId: request.requestId,
      childPid: 1234,
      childRuntimeId: "shell:child",
    });
  });

  it("stops through the original provider even after another desktop refreshes", async () => {
    const f = fixture();
    await register(f, "shell:initiating");
    const binding = f.registry.select({
      ownerUserId: "user:one",
      ownerRuntimeId: "shell:initiating",
      platform: process.platform,
      arch: process.arch,
    })!;
    const launch = f.registry.launch({
      runId: "run:one",
      binding,
      mainEntryBuildId: MAIN,
      executionDigest: DIGEST,
      recipeId: "recipe:one",
      artifactSource: { manifest: [], read: () => Buffer.alloc(0) },
      pairingDeepLink: "vibestudio://connect?request=opaque",
    });
    const requestId = (f.emitted[0]!.payload as { requestId: string }).requestId;
    await f.invoke(caller("shell:initiating", "user:one"), "launched", [
      { requestId, childPid: 1234, ownershipDigest: "c".repeat(64) },
    ]);
    await f.invoke(caller("shell:child", "user:one"), "attest", [{ requestId }]);
    await launch.ready;

    f.advance(10);
    await register(f, "shell:other");
    const stopping = f.registry.stop("run:one");
    expect(f.emitted.at(-1)).toMatchObject({
      callerId: "shell:initiating",
      event: "development:client-stop-request",
      payload: { requestId, runId: "run:one", childPid: 1234 },
    });
    await f.invoke(caller("shell:initiating", "user:one"), "exited", [
      { requestId, childPid: 1234, exitCode: 0, signal: null },
    ]);
    await expect(stopping).resolves.toBeUndefined();
  });

  it("classifies live exit from host-owned stop state and reports unexpected exits", async () => {
    const f = fixture();
    await register(f, "shell:initiating");
    const binding = f.registry.select({
      ownerUserId: "user:one",
      ownerRuntimeId: "shell:initiating",
      platform: process.platform,
      arch: process.arch,
    })!;
    const onExited = vi.fn();
    const launch = f.registry.launch({
      runId: "run:exit",
      binding,
      mainEntryBuildId: MAIN,
      executionDigest: DIGEST,
      recipeId: "recipe:one",
      artifactSource: { manifest: [], read: () => Buffer.alloc(0) },
      pairingDeepLink: "vibestudio://connect?request=opaque",
      onExited,
    });
    await f.invoke(caller("shell:initiating", "user:one"), "launched", [
      { requestId: launch.requestId, childPid: 1234, ownershipDigest: "c".repeat(64) },
    ]);
    await f.invoke(caller("shell:child", "user:one"), "attest", [{ requestId: launch.requestId }]);
    await launch.ready;
    await f.invoke(caller("shell:initiating", "user:one"), "exited", [
      { requestId: launch.requestId, childPid: 1234, exitCode: 7, signal: null },
    ]);
    expect(onExited).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: launch.requestId, unexpected: true, exitCode: 7 })
    );
  });

  it("records an isolated paired-child nonce and lets only the bound manager consume it", async () => {
    const generationId = "d".repeat(32);
    const f = fixture({ instanceId: "development-test", generationId });
    await f.invoke(caller("shell:manager", "child:root"), "bindIsolatedManager", [
      { instanceId: "development-test", generationId },
    ]);
    const requestId = `development-client-${"e".repeat(32)}`;
    await expect(
      f.invoke(caller("shell:child", "child:root"), "attest", [{ requestId }])
    ).resolves.toEqual({ accepted: true });
    await expect(
      f.invoke(caller("shell:other", "child:root"), "consumeAttestation", [{ requestId }])
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      f.invoke(caller("shell:manager", "child:root"), "consumeAttestation", [{ requestId }])
    ).resolves.toMatchObject({ requestId, childRuntimeId: "shell:child", attestedAt: 1_000 });
    await expect(
      f.invoke(caller("shell:manager", "child:root"), "consumeAttestation", [{ requestId }])
    ).resolves.toBeNull();
  });

  it("holds a stop requested during launch until the selected provider proves process exit", async () => {
    const f = fixture();
    await register(f, "shell:initiating");
    const binding = f.registry.select({
      ownerUserId: "user:one",
      ownerRuntimeId: "shell:initiating",
      platform: process.platform,
      arch: process.arch,
    })!;
    const onExited = vi.fn();
    const launch = f.registry.launch({
      runId: "run:stopping",
      binding,
      mainEntryBuildId: MAIN,
      executionDigest: DIGEST,
      recipeId: "recipe:one",
      artifactSource: { manifest: [], read: () => Buffer.alloc(0) },
      pairingDeepLink: "vibestudio://connect?request=opaque",
      onExited,
    });
    const stopping = f.registry.stop("run:stopping");
    expect(
      f.emitted.filter((event) => event.event === "development:client-stop-request")
    ).toHaveLength(0);
    await f.invoke(caller("shell:initiating", "user:one"), "launched", [
      { requestId: launch.requestId, childPid: 4321, ownershipDigest: "c".repeat(64) },
    ]);
    expect(f.emitted.at(-1)).toMatchObject({
      callerId: "shell:initiating",
      event: "development:client-stop-request",
      payload: { requestId: launch.requestId, childPid: 4321 },
    });
    await f.invoke(caller("shell:initiating", "user:one"), "exited", [
      { requestId: launch.requestId, childPid: 4321, exitCode: 0, signal: null },
    ]);
    await expect(stopping).resolves.toBeUndefined();
    await expect(launch.ready).rejects.toMatchObject({ code: "ECANCELLED" });
    expect(onExited).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: launch.requestId, unexpected: false })
    );
  });
});
