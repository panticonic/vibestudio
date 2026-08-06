import { describe, expect, it, vi } from "vitest";
import { semanticRepositoryDigest } from "./semanticRepository.js";

vi.mock("./source.js", () => ({
  acquireTemplateSnapshot: vi.fn(async () => ({
    files: [
      {
        path: "panels/one/index.ts",
        contentHash: "1".repeat(64),
        size: 1,
        mode: 0o644,
      },
      {
        path: "panels/two/index.ts",
        contentHash: "2".repeat(64),
        size: 1,
        mode: 0o644,
      },
    ],
  })),
}));

import {
  isTemplateOperationCancelled,
  readTemplateOperationRecord,
  reviewTemplateUpdates,
} from "./staging.js";

const BASE = { kind: "event", eventId: "event-base" } as const;
const OLD_ONE = "1".repeat(64);
const OLD_TWO = "2".repeat(64);
const NEW_ONE = "3".repeat(64);
const NEW_TWO = "4".repeat(64);

describe("template composer staging", () => {
  it("observes a missing operation without creating its context", async () => {
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "runtime.listContexts") return { contexts: [] };
      throw new Error(`unexpected RPC ${method}`);
    });

    await expect(
      readTemplateOperationRecord({ rpc: { call } } as never, "operation-missing")
    ).resolves.toBeNull();
    expect(call).not.toHaveBeenCalledWith("main", "runtime.createContext", expect.anything());
  });

  it("reads a durable cancellation from the exact protected-main event", async () => {
    const call = vi.fn(async (_target: string, method: string, input: Record<string, unknown>) => {
      if (method === "vcs.resolveRepository") {
        expect(input["state"]).toEqual({ kind: "event", eventId: "event:cancelled" });
        return { repositoryId: "repository:meta", repoPath: "meta" };
      }
      if (method === "vcs.readFile") {
        return {
          content: {
            kind: "text",
            text: `${JSON.stringify({ version: 1, operationId: "pull-1" })}\n`,
          },
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    await expect(
      isTemplateOperationCancelled({ rpc: { call } } as never, "event:cancelled", "pull-1")
    ).resolves.toBe(true);
  });

  it("registers every repository delta before reconciliation mutates the context", async () => {
    const registrations: string[] = [];
    let integrationStarted = false;
    const call = vi.fn(async (_target: string, method: string, ...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      if (method === "vcs.status") {
        return {
          committed: BASE,
          workingHead: BASE,
          clean: true,
        };
      }
      if (method === "vcs.resolveRepository") {
        return {
          repositoryId: `repository-${input["repoPath"]}`,
          repoPath: input["repoPath"],
        };
      }
      if (method === "vcs.registerExternalDelta") {
        if (integrationStarted) {
          throw new Error("registered a delta after reconciliation changed the working head");
        }
        const repoPath = String(input["repoPath"]);
        registrations.push(repoPath);
        return { deltaId: `delta-${repoPath}` };
      }
      if (method === "vcs.compare") {
        return { resolution: { complete: true, remainingCoordinateCount: 0, concluded: integrationStarted } };
      }
      if (method === "vcs.merge") {
        integrationStarted = true;
        return {};
      }
      if (method === "vcs.finalizeExternalDelta") return {};
      throw new Error(`unexpected RPC ${method}`);
    });
    const oldOneDigest = semanticRepositoryDigest([
      { path: "index.ts", contentHash: OLD_ONE, mode: 0o644, byteLength: 1 },
    ]);
    const oldTwoDigest = semanticRepositoryDigest([
      { path: "index.ts", contentHash: OLD_TWO, mode: 0o644, byteLength: 1 },
    ]);
    const previousPin = {
      url: "git+https://example.test/template.git",
      ref: "refs/tags/v1",
      commit: "1".repeat(40),
      snapshot: `v1-sha256:${"a".repeat(64)}`,
    };
    const nextPin = {
      ...previousPin,
      ref: "refs/tags/v2",
      commit: "2".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}`,
    };
    const files = (contentHash: string) => [
      { path: "index.ts", contentHash, size: 1, mode: 0o644 as const },
    ];
    const plan = {
      nodes: [{ nodeId: "t-next", pin: nextPin }],
      repositories: {
        "panels/one": {
          nodeId: "t-next",
          alias: "template",
          subdir: "panels/one",
          subtreeDigest: `v1-sha256:${"c".repeat(64)}`,
          files: files(NEW_ONE),
        },
        "panels/two": {
          nodeId: "t-next",
          alias: "template",
          subdir: "panels/two",
          subtreeDigest: `v1-sha256:${"d".repeat(64)}`,
          files: files(NEW_TWO),
        },
      },
    };
    const previous = {
      nodes: [{ nodeId: "t-old", pin: previousPin }],
      repositories: {
        "panels/one": { nodeId: "t-old", subtreeDigest: oldOneDigest },
        "panels/two": { nodeId: "t-old", subtreeDigest: oldTwoDigest },
      },
    };

    await expect(
      reviewTemplateUpdates(
        { rpc: { call } } as never,
        "/state",
        "operation-1",
        plan as never,
        previous as never
      )
    ).resolves.toEqual(["panels/one", "panels/two"]);
    expect(registrations).toEqual(["panels/one", "panels/two"]);
    expect(integrationStarted).toBe(true);
  });
});
