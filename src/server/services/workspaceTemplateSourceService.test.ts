import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import {
  acquireExactWorkspaceSource,
  createWorkspaceTemplateSourceService,
} from "./workspaceTemplateSourceService.js";

const sourceManifest = `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  name: Dirty source
  repositories: [panels/example]
  files: [package.json]
initPanels:
  - source: panels/example
`;

function snapshot() {
  const files = [
    { path: "meta/vibestudio.yml" },
    { path: "package.json" },
    { path: "panels/example/index.tsx" },
  ];
  return {
    files,
    readFile: (path: string) =>
      path === "meta/vibestudio.yml" ? Buffer.from(sourceManifest) : Buffer.from("{}"),
  };
}

describe("workspaceTemplateSource", () => {
  it("selects the exact registered snapshot when one URL has several pins", async () => {
    const shared = {
      url: "https://example.invalid/source.git",
      ref: "refs/heads/main",
    };
    const first = {
      ...shared,
      commit: "a".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}` as const,
    };
    const dirty = {
      ...shared,
      commit: "c".repeat(40),
      snapshot: `v1-sha256:${"d".repeat(64)}` as const,
    };
    const fromCheckout = vi.fn(async (source: { checkout: string }) => source.checkout);
    const fromRemote = vi.fn(async () => "remote");

    await expect(
      acquireExactWorkspaceSource({
        pin: dirty,
        sources: [
          { pin: first, checkout: "/owned/first" },
          { pin: dirty, checkout: "/owned/dirty" },
        ],
        fromCheckout,
        fromRemote,
      })
    ).resolves.toBe("/owned/dirty");
    expect(fromCheckout).toHaveBeenCalledWith({
      pin: dirty,
      checkout: "/owned/dirty",
    });
    expect(fromRemote).not.toHaveBeenCalled();
  });

  it("keeps same-URL exact pins distinct and returns only verified source facts", async () => {
    const first = {
      url: "https://example.invalid/source.git",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}` as const,
    };
    const second = {
      ...first,
      commit: "c".repeat(40),
      snapshot: `v1-sha256:${"d".repeat(64)}` as const,
    };
    const acquire = vi.fn(async (_pin: WorkspaceTemplatePin) => snapshot());
    const service = createWorkspaceTemplateSourceService({
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      acquire,
    });
    const id = "@workspace-extensions/templates";
    const ctx = {
      caller: {
        ...createVerifiedCaller(id, "extension", {
          callerId: id,
          callerKind: "extension",
          repoPath: "extensions/templates",
          effectiveVersion: "reviewed-version",
          executionDigest: "f".repeat(64),
          requested: [],
        }),
        codeApproved: true as const,
      },
    };
    for (const caller of [
      createVerifiedCaller(id, "extension"),
      { ...ctx.caller, codeApproved: undefined },
      { ...ctx.caller, code: { ...ctx.caller.code!, repoPath: "extensions/imposter" } },
    ]) {
      await expect(service.handler({ caller }, "inspectExact", [first])).rejects.toThrow(
        /reviewed source consumer/
      );
    }
    expect(acquire).not.toHaveBeenCalled();

    const one = await service.handler(ctx, "inspectExact", [first]);
    const two = await service.handler(ctx, "inspectExact", [second]);

    expect(acquire.mock.calls.map(([pin]) => pin)).toEqual([first, second]);
    expect(one).toEqual({
      pin: first,
      presentation: { name: "Dirty source" },
      repositories: ["panels/example"],
      files: ["package.json"],
    });
    expect(two).toMatchObject({ pin: second });
    expect(one).not.toHaveProperty("checkout");

    const shell = createVerifiedCaller("shell:user-1", "shell");
    await expect(
      service.handler({ caller: shell }, "inspectExact", [first])
    ).resolves.toMatchObject({
      pin: first,
    });
    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/other", "app") },
        "inspectExact",
        [first]
      )
    ).rejects.toThrow(/reviewed source consumer/);
  });
});
