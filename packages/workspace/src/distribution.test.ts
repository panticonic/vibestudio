import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { prepareWorkspaceDistribution, resolveDistributionInventory } from "./distribution.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-distribution-"));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function packageJson(
  name: string,
  dependencies: Record<string, string> = {},
  devDependencies: Record<string, string> = {}
): string {
  return `${JSON.stringify({ name, private: true, dependencies, devDependencies }, null, 2)}\n`;
}

describe("workspace distribution projection", () => {
  it("resolves the transitive local package closure from explicit roots", () => {
    const root = fixture();
    write(
      root,
      "panels/chat/package.json",
      packageJson("@workspace-panels/chat", { "@workspace/ui": "workspace:*" })
    );
    write(
      root,
      "packages/ui/package.json",
      packageJson("@workspace/ui", { "@workspace/runtime": "workspace:*" })
    );
    write(
      root,
      "packages/runtime/package.json",
      packageJson("@workspace/runtime", {}, { "@workspace/testkit": "workspace:*" })
    );
    write(root, "packages/testkit/package.json", packageJson("@workspace/testkit"));
    write(root, "packages/unrelated/package.json", packageJson("@workspace/unrelated"));

    expect(resolveDistributionInventory(root, ["panels/chat"])).toEqual([
      "packages/runtime",
      "packages/testkit",
      "packages/ui",
      "panels/chat",
    ]);
  });

  it("fails when a selected repository has an unsatisfied local dependency", () => {
    const root = fixture();
    write(
      root,
      "workers/agent/package.json",
      packageJson("@workspace-workers/agent", { "@workspace/missing": "workspace:*" })
    );

    expect(() => resolveDistributionInventory(root, ["workers/agent"])).toThrow(
      /requires missing local dependency @workspace\/missing/u
    );
  });

  it("includes explicit and implicit panel build templates in the source closure", () => {
    const root = fixture();
    write(
      root,
      "panels/svelte/package.json",
      JSON.stringify({ name: "@workspace-panels/svelte", vibestudio: { template: "svelte" } })
    );
    write(root, "panels/vanilla/package.json", packageJson("@workspace-panels/vanilla"));
    write(root, "templates/svelte/template.json", JSON.stringify({ framework: "svelte" }));
    write(root, "templates/default/template.json", JSON.stringify({ framework: "react" }));

    expect(resolveDistributionInventory(root, ["panels/svelte", "panels/vanilla"])).toEqual([
      "panels/svelte",
      "panels/vanilla",
      "templates/default",
      "templates/svelte",
    ]);
  });

  it("rejects an explicit panel build template missing from the source", () => {
    const root = fixture();
    write(
      root,
      "panels/missing/package.json",
      JSON.stringify({ name: "@workspace-panels/missing", vibestudio: { template: "missing" } })
    );
    expect(() => resolveDistributionInventory(root, ["panels/missing"])).toThrow(
      /requires missing build template templates\/missing/u
    );
  });

  it("rejects runtime source declarations outside the explicit inventory", () => {
    const root = fixture();
    write(root, "panels/chat/package.json", packageJson("@workspace-panels/chat"));

    expect(() =>
      prepareWorkspaceDistribution({
        sourceRoot: root,
        expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
        manifestContent: `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  repositories: []
  files: []
initPanels:
  - source: panels/chat
`,
      })
    ).toThrow(/panels\/chat.*outside its repository inventory/u);
  });

  it("plans only the resolved repositories, support files, and generated manifests", () => {
    const root = fixture();
    write(
      root,
      "panels/chat/package.json",
      packageJson("@workspace-panels/chat", { "@workspace/runtime": "workspace:*" })
    );
    write(root, "panels/chat/index.ts", "export {};\n");
    write(root, "packages/runtime/package.json", packageJson("@workspace/runtime"));
    write(root, "packages/runtime/index.ts", "export {};\n");
    write(root, "packages/unrelated/package.json", packageJson("@workspace/unrelated"));
    write(root, "package.json", packageJson("@workspace/root"));

    const prepared = prepareWorkspaceDistribution({
      sourceRoot: root,
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      manifestContent: `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}
template:
  name: Personal
  repositories: [panels/chat]
  files: [package.json]
initPanels:
  - source: panels/chat
`,
    });

    expect(prepared.repositories).toEqual(["packages/runtime", "panels/chat"]);
    expect(prepared.files.map((file) => file.path)).toEqual([
      "meta/vibestudio.yml",
      "package.json",
      "packages/runtime/index.ts",
      "packages/runtime/package.json",
      "panels/chat/index.ts",
      "panels/chat/package.json",
    ]);
    const manifestFile = prepared.files.find((file) => file.path === "meta/vibestudio.yml")!;
    expect("bytes" in manifestFile ? new TextDecoder().decode(manifestFile.bytes) : "").toContain(
      "- packages/runtime\n"
    );
    expect(prepared.files.some((file) => file.path.startsWith("packages/unrelated/"))).toBe(false);
  });
});
