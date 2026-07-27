import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { BrowserPermissionGrantProjection } from "./browserPermissionsService.js";

const statePaths: string[] = [];

function createProjection() {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-browser-grants-"));
  statePaths.push(statePath);
  const canonical = new CapabilityGrantStore({ statePath });
  return {
    canonical,
    projection: new BrowserPermissionGrantProjection(canonical, statePath),
  };
}

describe("BrowserPermissionGrantProjection", () => {
  afterEach(() => {
    for (const statePath of statePaths.splice(0)) {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });

  it("stores browser decisions as exact user grants scoped by environment and epoch", () => {
    const { canonical, projection } = createProjection();
    projection.remember("environment-a", "alice", "epoch-a-123456789", [
      {
        origin: "https://example.com",
        capability: "camera",
        decision: "allow",
        scope: "session",
        updatedAt: 100,
      },
    ]);

    expect(projection.list("environment-a", "alice", "epoch-a-123456789")).toEqual([
      {
        origin: "https://example.com",
        capability: "camera",
        decision: "allow",
        scope: "session",
        updatedAt: 100,
      },
    ]);
    expect(projection.list("environment-a", "alice", "epoch-b-123456789")).toEqual([]);
    expect(projection.list("environment-b", "alice", "epoch-a-123456789")).toEqual([]);
    expect(canonical.listActiveAuthorityGrants()[0]).toMatchObject({
      subject: "user:alice",
      capability: "browser.camera",
      effect: "allow",
      resource: { kind: "exact" },
    });
    canonical.close();
  });

  it("removes stale browser-session grants without touching durable decisions", () => {
    const { canonical, projection } = createProjection();
    projection.remember("environment-a", "alice", "epoch-old-123456789", [
      {
        origin: "https://session.example",
        capability: "microphone",
        decision: "allow",
        scope: "session",
        updatedAt: 100,
      },
    ]);
    projection.remember("environment-a", "alice", "epoch-old-123456789", [
      {
        origin: "https://durable.example",
        capability: "geolocation",
        decision: "allow",
        scope: "always",
        updatedAt: 101,
      },
    ]);

    expect(
      projection.cleanupPreviousSessions("environment-a", "alice", "epoch-current-123456789")
    ).toBe(1);
    expect(projection.list("environment-a", "alice", "epoch-current-123456789")).toEqual([
      expect.objectContaining({
        origin: "https://durable.example",
        capability: "geolocation",
        scope: "always",
      }),
    ]);
    canonical.close();
  });

  it("makes a remembered block replace prior allows and revoke as one site row", () => {
    const { canonical, projection } = createProjection();
    projection.remember("environment-a", "alice", "epoch-a-123456789", [
      {
        origin: "https://example.com",
        capability: "notifications",
        decision: "allow",
        scope: "always",
        updatedAt: 100,
      },
    ]);
    projection.remember("environment-a", "alice", "epoch-a-123456789", [
      {
        origin: "https://example.com",
        capability: "notifications",
        decision: "block",
        scope: "block",
        updatedAt: 101,
      },
      {
        origin: "https://example.com",
        capability: "downloads",
        decision: "allow",
        scope: "always",
        updatedAt: 102,
      },
    ]);

    const grants = projection.list("environment-a", "alice", "epoch-a-123456789");
    const grant = grants.find((candidate) => candidate.capability === "notifications");
    expect(grant).toMatchObject({ decision: "block", scope: "block" });
    expect(
      projection.revokeById(
        "environment-a",
        "alice",
        projection.idFor("environment-a", "alice", grant!)
      )
    ).toBe(true);
    expect(projection.list("environment-a", "alice", "epoch-a-123456789")).toEqual([]);
    canonical.close();
  });
});
