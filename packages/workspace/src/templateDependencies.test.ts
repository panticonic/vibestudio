import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTemplateDependency } from "@vibestudio/workspace-contracts/types";
import {
  resolveTemplateDependencies,
  type ResolvedTemplateDependency,
} from "./templateDependencies.js";

const base = "git+https://example.test/base.git";
const shared = "git+https://example.test/shared.git";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

/** A track glob resolves to a concrete tag, the way the real selector does. */
function selectedRef(track: string): string {
  return track.replace("*", "1.0.0");
}

function resolver(
  heads: Record<string, string>,
  graph: Record<string, readonly WorkspaceTemplateDependency[]> = {}
) {
  return {
    resolveTrack: vi.fn(async ({ url, track }: { url: string; track: string }) => {
      const commit = heads[`${url}#${track}`] ?? heads[url];
      if (!commit) throw new Error(`no such track ${url}#${track}`);
      return { ref: selectedRef(track), commit };
    }),
    readDependencies: vi.fn(async (layer: ResolvedTemplateDependency) => graph[layer.url] ?? []),
  };
}

describe("resolveTemplateDependencies", () => {
  it("resolves a floating dependency to whatever its ref names now", async () => {
    const io = resolver({ [base]: commitA });
    const { layers } = await resolveTemplateDependencies({
      root: { label: "workspace", dependencies: [{ url: base }] },
      ...io,
    });
    // Nothing said which version, so it followed the release track.
    expect(layers).toEqual([
      {
        url: base,
        track: "refs/tags/v*",
        ref: "refs/tags/v1.0.0",
        commit: commitA,
        pinned: false,
        requestedBy: ["workspace"],
      },
    ]);
  });

  it("lets two templates share one floating dependency without arbitration", async () => {
    // The point of leaving a dependency unpinned: the address resolves once, so
    // an ordinary diamond has nothing to disagree about.
    const io = resolver({ [base]: commitA, [shared]: commitB }, { [shared]: [{ url: base }] });
    const { layers } = await resolveTemplateDependencies({
      root: { label: "workspace", dependencies: [{ url: base }, { url: shared }] },
      ...io,
    });
    expect(layers.map((layer) => layer.url)).toEqual([base, shared]);
    expect(io.resolveTrack).toHaveBeenCalledTimes(2);
  });

  it("orders a dependency ahead of everything built on it", async () => {
    const io = resolver({ [base]: commitA, [shared]: commitB }, { [shared]: [{ url: base }] });
    const { layers } = await resolveTemplateDependencies({
      root: { label: "workspace", dependencies: [{ url: shared }] },
      ...io,
    });
    expect(layers.map((layer) => layer.url)).toEqual([base, shared]);
  });

  it("fails fast when two exact pins disagree", async () => {
    const left = "git+https://example.test/left.git";
    const right = "git+https://example.test/right.git";
    const io = resolver(
      { [left]: commitA, [right]: commitB },
      { [left]: [{ url: base, commit: commitA }], [right]: [{ url: base, commit: commitB }] }
    );
    await expect(
      resolveTemplateDependencies({
        root: { label: "workspace", dependencies: [{ url: left }, { url: right }] },
        ...io,
      })
    ).rejects.toThrow(/may carry only one exact commit/u);
  });

  it("lets one exact pin decide a dependency others leave floating", async () => {
    const io = resolver({ [base]: commitA, [shared]: commitB }, { [shared]: [{ url: base }] });
    const { layers } = await resolveTemplateDependencies({
      root: {
        label: "workspace",
        dependencies: [{ url: base, commit: commitB }, { url: shared }],
      },
      ...io,
    });
    const resolvedBase = layers.find((layer) => layer.url === base);
    expect(resolvedBase).toMatchObject({ commit: commitB, pinned: true });
    // Nothing asked the remote what `main` points at, because a pin already said.
    expect(io.resolveTrack).not.toHaveBeenCalledWith(expect.objectContaining({ url: base }));
  });

  it("refuses a pin that contradicts a float already resolved", async () => {
    const io = resolver(
      { [base]: commitA, [shared]: commitB },
      { [shared]: [{ url: base, commit: commitB }] }
    );
    await expect(
      resolveTemplateDependencies({
        root: { label: "workspace", dependencies: [{ url: base }, { url: shared }] },
        ...io,
      })
    ).rejects.toThrow(/pin it once at the root/u);
  });

  it("refuses one shared dependency followed on two different tracks", async () => {
    const io = resolver(
      { [base]: commitA, [shared]: commitB },
      { [shared]: [{ url: base, track: "refs/tags/next-v*" }] }
    );
    await expect(
      resolveTemplateDependencies({
        root: {
          label: "workspace",
          dependencies: [{ url: base, track: "refs/tags/v*" }, { url: shared }],
        },
        ...io,
      })
    ).rejects.toThrow(/may follow only one track/u);
  });

  it("stops on a dependency cycle instead of laying layers down forever", async () => {
    const io = resolver(
      { [base]: commitA, [shared]: commitB },
      { [base]: [{ url: shared }], [shared]: [{ url: base }] }
    );
    await expect(
      resolveTemplateDependencies({
        root: { label: "workspace", dependencies: [{ url: base }] },
        ...io,
      })
    ).rejects.toThrow(/cycle/u);
  });

  it("rejects a template that depends on itself", async () => {
    const io = resolver({ [base]: commitA }, { [base]: [{ url: base }] });
    await expect(
      resolveTemplateDependencies({
        root: { label: "workspace", dependencies: [{ url: base }] },
        ...io,
      })
    ).rejects.toThrow(/declares itself/u);
  });
});
