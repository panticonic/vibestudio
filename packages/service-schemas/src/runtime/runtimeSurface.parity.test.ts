import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  CREDENTIALS_MEMBERS,
  GAD_MEMBERS,
  GIT_MEMBERS,
  PANEL_TREE_MEMBERS,
  PANEL_TREE_METHOD_CATALOG,
  portableExports,
  VCS_MEMBERS,
  WEBHOOKS_MEMBERS,
} from "./runtimeSurface.portable.js";
import { vcsMethods } from "../vcs.js";

describe("runtime surface schemaRef parity", () => {
  it("every schemaRef resolves to a service-schemas source file", () => {
    const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = new Set(readdirSync(schemaDir));
    const dangling: string[] = [];
    for (const [name, entry] of Object.entries(portableExports)) {
      const ref = entry.schemaRef;
      if (ref && !files.has(`${ref}.ts`)) dangling.push(`${name} → ${ref}`);
    }
    expect(
      dangling,
      `runtime-surface schemaRef must name a service-schemas file: ${dangling.join(", ")}`
    ).toEqual([]);
  });

  it("documents the credential runtime API without linking to its internal wire transport", () => {
    const credentials = portableExports["credentials"];
    if (!credentials) throw new Error("missing credentials runtime surface");
    expect(credentials.members).toEqual(CREDENTIALS_MEMBERS);
    expect(credentials.members).toContain("fetch");
    expect(credentials.members).not.toContain("proxyFetch");
    expect(credentials.schemaRef).toBeUndefined();
    expect(credentials.description).toContain("fetch(url, init?, { credentialId? }?)");
  });

  it("distinguishes workspace build health from live worker discovery", () => {
    const workspace = portableExports["workspace"];
    if (!workspace) throw new Error("missing workspace runtime surface");
    expect(workspace.description).toContain("declared source/build readiness");
    expect(workspace.description).toContain("workers.listSources()");
    expect(workspace.description).toContain("runtime.supervision.list()");
  });

  it("links the direct openExternal helper to its typed approval-gated contract", () => {
    const openExternal = portableExports["openExternal"];
    if (!openExternal) throw new Error("missing openExternal runtime surface");
    expect(openExternal.kind).toBe("callable");
    if (openExternal.kind !== "callable") throw new Error("openExternal must be callable");
    expect(openExternal.schemaRef).toBe("externalOpen");
    expect(openExternal.schemaMethod).toBe("openExternal");
    expect(openExternal.description).toContain("server-side eval");
    expect(openExternal.description).toContain("panel/client eval");
    expect(openExternal.description).toContain("owns the approval prompt");
  });

  it("carries generated typed docs for every GAD runtime method", () => {
    const gad = portableExports["gad"];
    if (!gad) throw new Error("missing GAD runtime surface");
    expect(gad.members).toEqual(GAD_MEMBERS);
    expect(Object.keys(gad.methodCatalog ?? {})).toEqual(GAD_MEMBERS);
    expect(gad.methodCatalog?.["status"]).toMatchObject({
      description: expect.stringContaining("storage and projection status"),
      argsSchema: expect.any(Object),
      returnsSchema: expect.any(Object),
    });
    expect(gad.methodCatalog).not.toHaveProperty("query");
    expect(gad.methodCatalog).not.toHaveProperty("rawSql");
  });

  it("derives the documented VCS namespace from the canonical semantic registry", () => {
    const vcs = portableExports["vcs"];
    if (!vcs) throw new Error("missing VCS runtime surface");
    expect(VCS_MEMBERS).toEqual(Object.keys(vcsMethods));
    expect(vcs.members).toEqual(Object.keys(vcsMethods));
    expect(vcs.members).toContain("merge");
    expect(vcs.members).toContain("move");
    expect(vcs.members).toContain("neighbors");
    expect(vcs.members).not.toContain("moveFiles");
  });

  it("documents external Git as candidate-based and keeps protected main explicit", () => {
    const git = portableExports["git"];
    if (!git) throw new Error("missing git runtime surface");
    expect(git.members).toEqual(GIT_MEMBERS);
    expect(git.members).toContain("importProject");
    expect(git.members).toContain("pullUpstream");
    expect(git.members).not.toContain("completeWorkspaceDependencies");
    expect(git.description).toContain("unpublished semantic candidates");
    expect(git.description).toContain("explicit publication advance protected main");
    expect(git.description).toContain("anonymous-first");
  });

  it("documents the ergonomic webhook lifecycle without exposing its raw transport", () => {
    const webhooks = portableExports["webhooks"];
    if (!webhooks) throw new Error("missing webhooks runtime surface");
    expect(webhooks.members).toEqual(WEBHOOKS_MEMBERS);
    expect(webhooks.schemaRef).toBe("webhookIngress");
    expect(webhooks.description).toContain("rotateSecret(subscriptionId, secret?)");
    expect(webhooks.description).toContain("agent eval");
  });

  it("keeps panel-tree help aligned with the runtime contract", () => {
    const panelTree = portableExports["panelTree"];
    if (!panelTree) throw new Error("missing panelTree runtime surface");
    expect(panelTree.members).toEqual(PANEL_TREE_MEMBERS);
    expect(panelTree.members).toContain("navigateHistory");
    expect(PANEL_TREE_METHOD_CATALOG.page.argsSchema).toMatchObject({
      type: "array",
      prefixItems: [
        {
          properties: {
            group: {
              oneOf: expect.arrayContaining([
                expect.objectContaining({
                  properties: expect.objectContaining({ ownerUserId: expect.any(Object) }),
                  required: expect.arrayContaining(["ownerUserId"]),
                }),
              ]),
            },
          },
        },
      ],
    });
    expect(PANEL_TREE_METHOD_CATALOG.page.argsSchema).not.toEqual(
      expect.objectContaining({ rootGroup: expect.anything() })
    );
    expect(PANEL_TREE_METHOD_CATALOG.rootOwners.returnsSchema).toMatchObject({
      required: expect.arrayContaining(["owners", "nextCursor"]),
      properties: {
        owners: { type: "array", items: { required: ["ownerUserId", "rootCount"] } },
      },
    });
    expect(PANEL_TREE_METHOD_CATALOG.roots).toMatchObject({
      signature: expect.stringContaining("roots(input?: PanelTreePageWindow)"),
      description: expect.stringContaining("current verified human subject"),
      argsSchema: { type: "array", maxItems: 1 },
    });
    expect(PANEL_TREE_METHOD_CATALOG.rootsForOwner).toMatchObject({
      signature: expect.stringContaining("rootsForOwner(ownerUserId"),
      description: expect.stringContaining("Cross-owner workspace visibility is unchanged"),
    });
    expect(PANEL_TREE_METHOD_CATALOG.page.returnsSchema).toMatchObject({
      required: expect.arrayContaining(["entries", "nextCursor"]),
      properties: {
        entries: {
          type: "array",
          items: { required: ["node", "handle"] },
        },
      },
    });
    expect(PANEL_TREE_METHOD_CATALOG.search.returnsSchema).toMatchObject({
      required: expect.arrayContaining(["hits", "nextCursor"]),
      properties: {
        hits: {
          type: "array",
          items: {
            required: ["entry", "ancestors"],
            properties: { entry: { required: ["node", "handle"] } },
          },
        },
      },
    });
    expect(PANEL_TREE_METHOD_CATALOG.navigateHistory.signature).toContain(
      "navigateHistory(id: string"
    );
  });
});
