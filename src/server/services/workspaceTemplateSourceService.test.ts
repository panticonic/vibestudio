import { canonicalSnapshotDigest, sha256HexSyncText } from "@vibestudio/content-addressing";
import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import type { TemplateSourceTree } from "@vibestudio/service-schemas/templates";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import {
  acquireExactWorkspaceSource,
  createWorkspaceTemplateSourceService,
} from "./workspaceTemplateSourceService.js";

const sourceManifest = `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  name: Dirty source
  repositories: [panels/example]
initPanels:
  - source: panels/example
`;

function snapshot(manifest = sourceManifest) {
  const files = [{ path: "meta/vibestudio.yml" }, { path: "panels/example/index.tsx" }];
  const descriptors = files.map((file) => {
    const content = file.path === "meta/vibestudio.yml" ? manifest : "{}";
    return {
      ...file,
      contentHash: sha256HexSyncText(content),
      size: Buffer.byteLength(content),
      mode: 0o644 as const,
    };
  });
  return {
    commit: "a".repeat(40),
    snapshot: canonicalSnapshotDigest(descriptors.map((file) => ({ ...file, mode: 0o100644 }))),
    files: descriptors,
    readFile: (path: string) =>
      path === "meta/vibestudio.yml" ? Buffer.from(manifest) : Buffer.from("{}"),
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
    };
    const dirty = {
      ...shared,
      commit: "c".repeat(40),
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
    };
    const second = {
      ...first,
      commit: "c".repeat(40),
    };
    const acquire = vi.fn(async (_pin: WorkspaceTemplatePin) => snapshot());
    const resolveLocal = vi.fn((url: string) => (url === first.url ? first : null));
    const registry = {
      version: 1 as const,
      templates: [
        {
          id: "source",
          role: "catalog" as const,
          name: "Source",
          description: "A moving template source",
          url: first.url,
        },
      ],
    };
    const put = vi.fn(async (_bytes: Uint8Array) => undefined);
    const service = createWorkspaceTemplateSourceService({
      put,
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      acquire,
      resolveLocal,
      localRegistry: () => registry,
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
      dependencies: [],
    });
    expect(two).toMatchObject({ pin: second });
    const composed = (await service.handler(ctx, "composeExact", [
      { sources: [first] },
    ])) as TemplateSourceTree;
    expect(composed.sources).toEqual([first]);
    expect(composed.repositories.map((repo) => repo.repoPath)).toEqual(["meta", "panels/example"]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(put.mock.calls[0]![0])).toContain(first.commit);
    await expect(
      service.handler(ctx, "composeExact", [{ sources: [first, second] }])
    ).rejects.toThrow("one exact pin");
    expect(one).not.toHaveProperty("checkout");
    await expect(service.handler(ctx, "resolveLocal", [first.url])).resolves.toEqual(first);
    await expect(service.handler(ctx, "localRegistry", [])).resolves.toEqual(registry);
    await expect(
      service.handler(ctx, "resolveLocal", ["https://example.invalid/other.git"])
    ).resolves.toBeNull();

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
  it("reads a foreign epoch without interpreting that epoch's manifest schema", async () => {
    const foreignEpoch = WORKSPACE_SYSTEM_EPOCH + 1;
    const acquire = vi.fn(async () =>
      snapshot(`systemEpoch: ${foreignEpoch}\nfutureSchema: { unknownToday: true }\n`)
    );
    const service = createWorkspaceTemplateSourceService({
      put: vi.fn(),
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      acquire,
      resolveLocal: () => null,
      localRegistry: () => null,
    });
    const ctx = { caller: createVerifiedCaller("shell:user-1", "shell") };
    const pin = { url: "https://example.invalid/source.git", ref: "main", commit: "a".repeat(40) };
    await expect(service.handler(ctx, "readEpoch", [pin])).resolves.toBe(foreignEpoch);
    await expect(service.handler(ctx, "inspectExact", [pin])).rejects.toThrow();
    await expect(
      service.handler({ caller: createVerifiedCaller("other", "app") }, "readEpoch", [pin])
    ).rejects.toThrow(/reviewed source consumer/);
  });
});
