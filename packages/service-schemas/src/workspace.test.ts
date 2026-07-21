import { describe, expect, it } from "vitest";
import { HostTargetLaunchResultSchema } from "./workspace.js";

describe("HostTargetLaunchResultSchema", () => {
  it("preserves immutable execution authority on a ready launch", () => {
    const ready = {
      status: "ready" as const,
      launched: true as const,
      target: "electron" as const,
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      buildKey: "cache-key",
      artifactRoute: "/_a/shell/index.html",
      capabilities: ["panel-hosting" as const],
      effectiveVersion: "ev-1",
      executionDigest: "a".repeat(64),
      authorityRequests: [
        {
          capability: "service:events.watch",
          resource: { kind: "exact" as const, key: "service:events.watch" },
        },
      ],
      authorityDelegations: [
        {
          audience: "eval" as const,
          purpose: "agentic-code-execution" as const,
          capabilities: [
            {
              capability: "runtime:entity.create",
              resource: { kind: "prefix" as const, prefix: "panels/" },
            },
          ],
        },
      ],
      adoptionPolicy: "immediate" as const,
    };

    expect(HostTargetLaunchResultSchema.parse(ready)).toEqual(ready);
  });

  it("rejects malformed authority instead of discarding it", () => {
    const parsed = HostTargetLaunchResultSchema.safeParse({
      status: "ready",
      launched: true,
      target: "electron",
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      buildKey: "cache-key",
      executionDigest: "a".repeat(64),
      authorityRequests: [{ capability: "service:events.watch" }],
    });

    expect(parsed.success).toBe(false);
  });
});
