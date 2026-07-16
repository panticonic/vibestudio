import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { CapabilityGrantStore, capabilityGrantId } from "./capabilityGrantStore.js";
import { createPermissionsService } from "./permissionsService.js";

const DIGEST = "a".repeat(64);
const roots: string[] = [];

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "permissions-service-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("permissionsService", () => {
  it("lists and revokes the exact canonical capability grant consumed by dispatch", async () => {
    const capabilityGrants = new CapabilityGrantStore({ statePath: statePath() });
    capabilityGrants.grant(
      "cors-response-read",
      "https://example.com",
      {
        principal: `code:workers/agent-worker@${DIGEST}`,
        sessionId: "do:workers/agent-worker:Agent:one",
        code: { repoPath: "workers/agent-worker", executionDigest: DIGEST },
      },
      "session",
      { kind: "origin", origin: "https://example.com" },
      10
    );
    const grant = capabilityGrants.listSession()[0]!;
    const service = createPermissionsService({
      capabilityGrants,
      userlandGrants: {
        listPersistent: vi.fn(() => []),
        revokePersistent: vi.fn(() => false),
      } as never,
      credentialUseGrants: {
        listAll: vi.fn(() => []),
        revoke: vi.fn(() => false),
      } as never,
    });
    const context = { caller: createVerifiedCaller("server:test", "server") };

    await expect(service.handler(context, "list", [])).resolves.toEqual([
      expect.objectContaining({
        id: capabilityGrantId(grant),
        kind: "capability",
        capability: "cors-response-read",
        resource: "https://example.com",
        scopeLabel: "Allowed until Vibestudio restarts",
      }),
    ]);

    await expect(
      service.handler(context, "revoke", [{ kind: "capability", id: capabilityGrantId(grant) }])
    ).resolves.toBeUndefined();
    expect(capabilityGrants.listSession()).toEqual([]);
  });

  it("routes each opaque grant kind only to its owning store", async () => {
    const revokeUserland = vi.fn((id: string) => id === "userland-id");
    const revokeCredential = vi.fn(async (id: string) => id === "credential-id");
    const service = createPermissionsService({
      capabilityGrants: new CapabilityGrantStore({ statePath: statePath() }),
      userlandGrants: {
        listPersistent: vi.fn(() => []),
        revokePersistent: revokeUserland,
      } as never,
      credentialUseGrants: {
        listAll: vi.fn(() => []),
        revoke: revokeCredential,
      } as never,
    });
    const context = { caller: createVerifiedCaller("server:test", "server") };

    await service.handler(context, "revoke", [{ kind: "userland", id: "userland-id" }]);
    await service.handler(context, "revoke", [{ kind: "credential-use", id: "credential-id" }]);

    expect(revokeUserland).toHaveBeenCalledWith("userland-id");
    expect(revokeCredential).toHaveBeenCalledWith("credential-id");
  });
});
