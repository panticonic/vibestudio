import { afterEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDependencyWorkspaceRoot } from "./dependencyWorkspaceRoot.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

describe("resolveDependencyWorkspaceRoot", () => {
  it("uses only the active semantic workspace even beside a convincing decoy", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dep-workspace-root-"));
    roots.push(root);
    const active = path.join(root, "active");
    const decoy = path.join(root, "workspace");
    await fsp.mkdir(active);
    await fsp.mkdir(decoy);
    await fsp.writeFile(path.join(active, "pnpm-workspace.yaml"), "packages: []\n");
    await fsp.writeFile(path.join(decoy, "package.json"), '{"name":"ambient-decoy"}\n');
    expect(resolveDependencyWorkspaceRoot(active)).toBe(active);
  });

  it("fails instead of falling back when exact workspace metadata is absent", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dep-workspace-root-"));
    roots.push(root);
    expect(() => resolveDependencyWorkspaceRoot(root)).toThrow(/no dependency workspace metadata/);
  });
});
