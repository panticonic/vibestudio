import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { discoverPackageGraph } from "./packageGraph.js";
import { typecheckDependencyGraph } from "./typecheckDependencyGraph.js";
import { collectExternalDependencyClosure } from "./externalDeps.js";

it("resolves authored test requirements and selected SDK declarations without changing runtime composition", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typecheck-dependency-graph-"));
  try {
    const workspace = path.join(root, "semantic");
    const appRoot = path.join(root, "installed");
    const write = (directory: string, manifest: object) => {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
    };
    write(path.join(workspace, "packages", "target"), {
      name: "@workspace/target",
      version: "1.0.0",
      dependencies: { "@vibestudio/contract": "workspace:*" },
      devDependencies: { "@workspace/test-helper": "workspace:*", "@types/react": "19.2.18" },
    });
    write(path.join(workspace, "packages", "test-helper"), {
      name: "@workspace/test-helper",
      version: "1.0.0",
      dependencies: { "@workspace/target": "workspace:*", zod: "3.25.76" },
    });
    const sdk = path.join(appRoot, "packages", "contract");
    write(sdk, {
      name: "@vibestudio/contract",
      exports: "./src/index.ts",
      devDependencies: { "@types/node": "24.10.1" },
    });
    write(path.join(appRoot, "packages", "unrelated"), {
      name: "@vibestudio/unrelated",
      dependencies: { irrelevant: "1.0.0" },
    });
    const graph = discoverPackageGraph(workspace);
    const unit = graph.get("@workspace/target");
    const compiler = typecheckDependencyGraph(unit, graph, appRoot, []);
    expect(compiler.workspacePackages).toEqual({ "@vibestudio/contract": sdk });
    expect(
      compiler.graph
        .allNodes()
        .map((node) => node.name)
        .sort()
    ).toEqual(["@vibestudio/contract", "@workspace/target", "@workspace/test-helper"]);
    expect(
      collectExternalDependencyClosure(compiler.graph.get(unit.name), compiler.graph).installSet
    ).toEqual({
      "@types/react": "19.2.18",
      "@types/node": "24.10.1",
      zod: "3.25.76",
    });
    expect(unit.dependencies).toEqual({ "@vibestudio/contract": "workspace:*" });
    expect(unit.internalDeps).not.toContain("@workspace/test-helper");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
