import { describe, expect, it, vi } from "vitest";
import type { AppHost } from "../appHost.js";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { createAppUnitDriver } from "./appUnitDriver.js";

describe("app unit diagnostics", () => {
  it("returns exact log and error buffers with store metadata from one snapshot", async () => {
    const identity = { kind: "app" as const, entityId: "@workspace-apps/shell" };
    const row = {
      id: identity.entityId,
      kind: "app",
      source: { repoPath: "apps/shell", effectiveVersion: "ev-1" },
      contextId: "main",
      key: identity.entityId,
      createdAt: 1,
      status: "active",
    };
    const history = vi.fn(() => ({
      entries: [
        {
          entityId: identity.entityId,
          kind: "app" as const,
          timestamp: 1,
          level: "info" as const,
          message: "started",
          source: "runner" as const,
        },
      ],
      errors: [
        {
          entityId: identity.entityId,
          kind: "app" as const,
          timestamp: 2,
          level: "error" as const,
          message: "child exited",
          source: "stderr" as const,
        },
      ],
      dropped: { entries: 3, errors: 1 },
      capacity: { entries: 1000, errors: 500 },
    }));
    const driver = createAppUnitDriver({
      getHost: () =>
        ({
          listWorkspaceUnits: () => [{ name: identity.entityId, displayName: "Shell" }],
          restart: vi.fn(),
          retire: vi.fn(),
        }) as unknown as AppHost,
      entityCache: {
        listActive: () => [row],
        resolveActive: (id: string) => (id === row.id ? row : null),
      } as unknown as Pick<EntityCache, "listActive" | "resolveActive">,
      diagnostics: { history },
    });

    expect(driver.health(identity.entityId)).toMatchObject({
      entity: { identity },
      logs: [{ message: "started", source: "runner" }],
      errors: [{ message: "child exited", source: "stderr" }],
      dropped: { entries: 3, errors: 1 },
      capacity: { entries: 1000, errors: 500 },
    });
    expect(history).toHaveBeenCalledExactlyOnceWith(identity.entityId, undefined);
  });
});
