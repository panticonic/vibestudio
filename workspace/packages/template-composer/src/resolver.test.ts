import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import type { ExactGitSnapshot, ExactSnapshotFile } from "@vibestudio/git";
import { WorkspaceConfigTopLayerSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceTemplateDeclaration,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import {
  normalizeTemplateGitUrl,
  templateAliasFromUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { resolveTemplateComposition, type TemplateSourcePorts } from "./resolver.js";
import { inspectTemplateOperation } from "./operations.js";

const epoch = 57;
const baseUrl = "https://github.com/vibestudio/workspace-base.git";
const newsUrl = "https://github.com/vibestudio/template-news.git";
const browserUrl = "https://github.com/vibestudio/template-browser.git";

function pin(url: string, digit: string): WorkspaceTemplatePin {
  return {
    url,
    ref: "refs/tags/v1.0.0",
    commit: digit.repeat(40),
    snapshot: `v1-sha256:${digit.repeat(64)}`,
  };
}

function file(path: string, bytes: Uint8Array): ExactSnapshotFile {
  return {
    path,
    contentHash: sha256Hex(bytes),
    size: bytes.byteLength,
    mode: 0o644,
  };
}

function snapshot(
  exact: WorkspaceTemplatePin,
  dependencies: readonly WorkspaceTemplateDeclaration[],
  repoPath: string,
  presentation?: { name?: string; description?: string }
): ExactGitSnapshot {
  const manifest = new TextEncoder().encode(
    [
      `systemEpoch: ${epoch}`,
      ...(presentation === undefined
        ? []
        : [
            "template:",
            ...(presentation.name === undefined
              ? []
              : [`  name: ${JSON.stringify(presentation.name)}`]),
            ...(presentation.description === undefined
              ? []
              : [`  description: ${JSON.stringify(presentation.description)}`]),
          ]),
      ...(dependencies.length === 0
        ? []
        : [
            "templates:",
            "  use:",
            ...dependencies.flatMap((dependency) => [
              `    - url: ${dependency.url}`,
              ...(dependency.credential ? [`      credential: ${dependency.credential}`] : []),
            ]),
          ]),
      "",
    ].join("\n")
  );
  const source = new TextEncoder().encode(`export const source = ${JSON.stringify(repoPath)};\n`);
  const files = [file("meta/template.yml", manifest), file(`${repoPath}/index.ts`, source)];
  const bytes = new Map([
    ["meta/template.yml", manifest],
    [`${repoPath}/index.ts`, source],
  ]);
  return {
    commit: exact.commit,
    snapshot: exact.snapshot,
    files,
    readFile: (path) => bytes.get(path) ?? null,
  };
}

function ports(
  pins: readonly WorkspaceTemplatePin[],
  snapshots: ReadonlyMap<string, ExactGitSnapshot>
): TemplateSourcePorts & { resolvePromoted: ReturnType<typeof vi.fn> } {
  const byUrl = new Map(pins.map((value) => [normalizeTemplateGitUrl(value.url), value]));
  return {
    resolvePromoted: vi.fn(async (declaration: WorkspaceTemplateDeclaration) => {
      const exact = byUrl.get(normalizeTemplateGitUrl(declaration.url));
      if (!exact) throw new Error(`No promoted pin for ${declaration.url}`);
      return exact;
    }),
    acquire: async (exact) => {
      const value = snapshots.get(normalizeTemplateGitUrl(exact.url));
      if (!value) throw new Error(`No snapshot for ${exact.url}`);
      return value;
    },
  };
}

describe("D1 template declarations", () => {
  it("accepts URL-only dependencies and rejects exact coordinates in manifests", () => {
    expect(
      WorkspaceConfigTopLayerSchema.parse({
        systemEpoch: epoch,
        templates: { use: [{ url: baseUrl, credential: "github-main" }] },
      }).templates?.use
    ).toEqual([{ url: baseUrl, credential: "github-main" }]);

    expect(() =>
      WorkspaceConfigTopLayerSchema.parse({
        systemEpoch: epoch,
        templates: {
          use: [
            {
              url: baseUrl,
              ref: "refs/tags/v1.0.0",
              commit: "a".repeat(40),
              snapshot: `v1-sha256:${"a".repeat(64)}`,
            },
          ],
        },
      })
    ).toThrow();
  });
});

describe("resolveTemplateComposition", () => {
  it("keeps every already-locked URL exact and resolves only a newly added URL", async () => {
    const base = pin(baseUrl, "a");
    const news = pin(newsUrl, "b");
    const browser = pin(browserUrl, "c");
    const snapshots = new Map([
      [normalizeTemplateGitUrl(baseUrl), snapshot(base, [], "packages/runtime")],
      [normalizeTemplateGitUrl(newsUrl), snapshot(news, [{ url: baseUrl }], "panels/news")],
      [
        normalizeTemplateGitUrl(browserUrl),
        snapshot(browser, [{ url: baseUrl }], "panels/browser"),
      ],
    ]);
    const initialPorts = ports([base, news], snapshots);
    const initial = await resolveTemplateComposition({
      roots: [{ url: newsUrl }],
      expectedSystemEpoch: epoch,
      ports: initialPorts,
    });
    expect(initialPorts.resolvePromoted).toHaveBeenCalledTimes(2);

    const removed = await inspectTemplateOperation({
      kind: "remove",
      templateUrl: newsUrl,
      workspace: {
        roots: [{ url: newsUrl }],
        lock: initial.lock!,
        localRepoPaths: new Set(["packages/runtime", "panels/news"]),
        externallyOwnedRepoPaths: new Set(),
        expectedSystemEpoch: epoch,
      },
      sources: ports([], snapshots),
    });
    expect(removed.plan.lock).toBeNull();
    expect(removed.plan.removedArtifactPaths).toContain("meta/templates.lock.yml");
    expect(removed.plan.ownershipChanges.map((change) => change.repoPath)).toEqual([
      "packages/runtime",
      "panels/news",
    ]);

    const addPorts = ports([browser], snapshots);
    const added = await resolveTemplateComposition({
      roots: [{ url: newsUrl }, { url: browserUrl }],
      previousLock: initial.lock!,
      localRepoPaths: new Set(["packages/runtime", "panels/news"]),
      expectedSystemEpoch: epoch,
      ports: addPorts,
    });

    expect(addPorts.resolvePromoted).toHaveBeenCalledTimes(1);
    expect(addPorts.resolvePromoted).toHaveBeenCalledWith({
      url: normalizeTemplateGitUrl(browserUrl),
    });
    expect(
      added.nodes.find((node) => node.pin.url === normalizeTemplateGitUrl(baseUrl))?.pin.commit
    ).toBe(base.commit);
    expect(
      added.nodes.find((node) => node.pin.url === normalizeTemplateGitUrl(newsUrl))?.pin.commit
    ).toBe(news.commit);
  });

  it("carries what a template calls itself into the lock, and out of the fragment", async () => {
    // The name is the only text a template gets to assert about itself, and it
    // belongs to the pin that asserted it — not to the configuration a
    // dependent inherits, which is why the fragment must not carry it.
    const news = pin(newsUrl, "b");
    const plan = await resolveTemplateComposition({
      roots: [{ url: newsUrl }],
      expectedSystemEpoch: epoch,
      ports: ports(
        [news],
        new Map([
          [
            normalizeTemplateGitUrl(newsUrl),
            snapshot(news, [], "panels/news", {
              name: "News",
              description: "Read and discuss personalized news briefings.",
            }),
          ],
        ])
      ),
    });

    expect(plan.lock!.nodes[0]!.presentation).toEqual({
      name: "News",
      description: "Read and discuss personalized news briefings.",
    });
    expect(plan.nodes[0]!.fragment).not.toHaveProperty("template");
  });

  it("keeps a hostile self-given name out of workspace state entirely", async () => {
    const news = pin(newsUrl, "b");
    const plan = await resolveTemplateComposition({
      roots: [{ url: newsUrl }],
      expectedSystemEpoch: epoch,
      ports: ports(
        [news],
        new Map([
          [
            normalizeTemplateGitUrl(newsUrl),
            snapshot(news, [], "panels/news", {
              // An interpunct forges the header's own field separator; the
              // description is longer than the one line it is given.
              name: "News \u00B7 github.com/vibestudio",
              description: "x".repeat(201),
            }),
          ],
        ])
      ),
    });

    // Nothing partial survives: a repaired hostile string is still its author's.
    expect(plan.lock!.nodes[0]!.presentation).toBeUndefined();
  });

  it("derives one stable alias from the URL even when a URL is both root and dependency", async () => {
    const base = pin(baseUrl, "a");
    const news = pin(newsUrl, "b");
    const snapshots = new Map([
      [normalizeTemplateGitUrl(baseUrl), snapshot(base, [], "packages/runtime")],
      [normalizeTemplateGitUrl(newsUrl), snapshot(news, [{ url: baseUrl }], "panels/news")],
    ]);
    const plan = await resolveTemplateComposition({
      roots: [{ url: baseUrl }, { url: newsUrl }],
      expectedSystemEpoch: epoch,
      ports: ports([base, news], snapshots),
    });

    expect(plan.nodes).toHaveLength(2);
    for (const node of plan.nodes) {
      expect(node.alias).toBe(templateAliasFromUrl(node.pin.url));
    }
    expect(new Set(plan.nodes.map((node) => node.alias)).size).toBe(2);
  });

  it("lets an explicit exact override move one URL without moving its locked dependency", async () => {
    const base = pin(baseUrl, "a");
    const newsV1 = pin(newsUrl, "b");
    const newsV2 = pin(newsUrl, "d");
    const initialSnapshots = new Map([
      [normalizeTemplateGitUrl(baseUrl), snapshot(base, [], "packages/runtime")],
      [normalizeTemplateGitUrl(newsUrl), snapshot(newsV1, [{ url: baseUrl }], "panels/news")],
    ]);
    const initial = await resolveTemplateComposition({
      roots: [{ url: newsUrl }],
      expectedSystemEpoch: epoch,
      ports: ports([base, newsV1], initialSnapshots),
    });
    const updatedSnapshots = new Map(initialSnapshots);
    updatedSnapshots.set(
      normalizeTemplateGitUrl(newsUrl),
      snapshot(newsV2, [{ url: baseUrl }], "panels/news")
    );
    const noNetwork = ports([], updatedSnapshots);
    const updated = await resolveTemplateComposition({
      roots: [{ url: newsUrl }],
      pinOverrides: { [newsUrl]: newsV2 },
      previousLock: initial.lock!,
      expectedSystemEpoch: epoch,
      ports: noNetwork,
    });

    expect(noNetwork.resolvePromoted).not.toHaveBeenCalled();
    expect(
      updated.nodes.find((node) => node.pin.url === normalizeTemplateGitUrl(newsUrl))?.pin
    ).toMatchObject({ commit: newsV2.commit });
    expect(
      updated.nodes.find((node) => node.pin.url === normalizeTemplateGitUrl(baseUrl))?.pin
    ).toMatchObject({ commit: base.commit });
  });
});
