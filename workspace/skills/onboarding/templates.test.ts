import { describe, expect, it, vi } from "vitest";
import { composeOptionalTemplateSnapshot, loadOptionalTemplateSnapshot } from "./templates.js";

const runtime = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@workspace/runtime", () => ({
  extensions: { invoke: runtime.invoke },
}));

const coordinates = {
  url: "git+https://example.test/registry.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}`,
};

function catalog() {
  return {
    version: 1,
    revision: "2026-08-10.1",
    systemEpoch: 57,
    coordinates,
    source: "verified",
    stale: false,
    verifiedAt: "2026-08-10T12:00:00.000Z",
    entries: [
      {
        id: "examples",
        name: "Examples",
        description: "Examples",
        tags: [],
        recommended: true,
        url: "git+https://example.test/examples.git",
        promoted: {
          ref: "refs/tags/v1",
          commit: "c".repeat(40),
          snapshot: `v1-sha256:${"d".repeat(64)}`,
        },
      },
      {
        id: "private-lab",
        name: "Private lab",
        description: "Not recommended for onboarding.",
        tags: [],
        recommended: false,
        url: "git+https://example.test/private-lab.git",
        promoted: {
          ref: "refs/tags/v1",
          commit: "e".repeat(40),
          snapshot: `v1-sha256:${"f".repeat(64)}`,
        },
      },
    ],
  } as never;
}

describe("optional onboarding templates", () => {
  it("explicitly refreshes the verified registry for a first-run overview", async () => {
    runtime.invoke.mockImplementation(async (_extension, method) => {
      if (method === "catalog") return catalog();
      if (method === "status") return [];
      throw new Error(`unexpected method ${method}`);
    });

    const snapshot = await composeOptionalTemplateSnapshot();

    expect(runtime.invoke).toHaveBeenCalledWith(
      "@workspace-extensions/template-composer",
      "catalog",
      [{ refresh: true }]
    );
    expect(snapshot).toEqual([
      expect.objectContaining({ id: "template.examples", state: "available" }),
    ]);
  });

  it("rechecks installation against the cached catalog after an overview rerender", async () => {
    runtime.invoke.mockImplementation(async (_extension, method) => {
      if (method === "catalog") return catalog();
      if (method === "status") {
        return [{ url: "git+https://example.test/examples.git" }];
      }
      throw new Error(`unexpected method ${method}`);
    });

    const snapshot = await loadOptionalTemplateSnapshot({ refreshCatalog: false });

    expect(runtime.invoke).toHaveBeenCalledWith(
      "@workspace-extensions/template-composer",
      "catalog",
      []
    );
    expect(snapshot).toEqual([
      expect.objectContaining({ id: "template.examples", state: "installed" }),
    ]);
  });

  it("projects recommended registry entries and their installed state", async () => {
    const status = vi.fn(async () => [{ url: "git+https://example.test/examples.git" }] as never);
    const readCatalog = vi.fn(async () => catalog());

    const snapshot = await composeOptionalTemplateSnapshot({
      status,
      catalog: readCatalog,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    expect(status).toHaveBeenCalledOnce();
    expect(readCatalog).toHaveBeenCalledOnce();
    expect(snapshot).toEqual([
      expect.objectContaining({
        id: "template.examples",
        title: "Examples",
        state: "installed",
        selection: {
          catalogId: "examples",
          registryCommit: coordinates.commit,
          registrySnapshot: coordinates.snapshot,
        },
      }),
    ]);
  });

  it("keeps registry choices visible but inert when status is unavailable", async () => {
    const snapshot = await composeOptionalTemplateSnapshot({
      catalog: async () => catalog(),
      status: vi.fn(async () => {
        throw new Error("private diagnostic");
      }),
    });

    expect(snapshot.every((entry) => entry.state === "unknown")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private diagnostic");
  });

  it("does not invent template choices when no verified registry is available", async () => {
    await expect(
      composeOptionalTemplateSnapshot({
        catalog: vi.fn(async () => {
          throw new Error("registry unavailable");
        }),
      })
    ).resolves.toEqual([]);
  });

  it("keeps an explicit UI load failure visible to its caller", async () => {
    await expect(
      loadOptionalTemplateSnapshot({
        catalog: vi.fn(async () => {
          throw new Error("registry unavailable");
        }),
      })
    ).rejects.toThrow("registry unavailable");
  });
});
