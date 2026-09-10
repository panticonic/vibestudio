import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareWorkspaceDistribution } from "@vibestudio/workspace/distribution";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

const sourceRoot = process.env["VIBESTUDIO_USERLAND_ROOT"];
if (!sourceRoot)
  throw new Error("Workspace distribution acceptance requires the exact Base checkout");
function prepare(role: string, provided?: ReadonlySet<string>) {
  return prepareWorkspaceDistribution({
    sourceRoot,
    manifestContent: readFileSync(
      path.join(sourceRoot, "meta/distributions", `${role}.yml`),
      "utf8"
    ),
    expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
    ...(provided ? { providedRepositories: provided } : {}),
  });
}

// Personal and System are built on Base, so Base is prepared first and its
// repositories are what they are allowed to leave out.
const base = prepare("base");
const provided = new Set(base.repositories.filter((repoPath) => repoPath !== "meta"));
const distributions = {
  base,
  personal: prepare("personal", provided),
  system: prepare("system", provided),
};

describe("the shipped workspace source boundaries", () => {
  it("keeps generic Base independent of personal data and native app implementations", () => {
    const base = distributions["base"]!;
    expect(base.repositories).toEqual(
      expect.arrayContaining([
        "about/new",
        "about/testbench",
        "panels/chat",
        "workers/agent-worker",
        "workers/quickfire-service",
        "extensions/templates",
        "extensions/test-runner",
        "skills/templates",
      ])
    );
    for (const repository of base.repositories) {
      expect(repository).not.toMatch(/^apps\//u);
      expect(repository).not.toMatch(
        /^(?:workers|extensions)\/(?:browser-data|phone-provisioning|system-agent|explorer-agent)$/u
      );
      expect(repository).not.toMatch(/^skills\/(?:memory|browser-import|mobile)$/u);
    }
    expect(base.manifest.top.apps).toBeUndefined();
    expect(base.manifest.top.hostTargets).toBeUndefined();
    expect(base.manifest.top.providers?.browserData).toBeUndefined();
  });

  it("puts personal browsing in Personal and native client hosting in System", () => {
    const personal = distributions["personal"]!;
    const system = distributions["system"]!;
    expect(personal.repositories).toContain("workers/browser-data");
    expect(personal.repositories).toContain("skills/memory");
    expect(personal.manifest.top.providers?.browserData?.extension).toBe("extensions/browser-data");
    expect(personal.repositories.some((repository) => repository.startsWith("apps/"))).toBe(false);
    expect(personal.manifest.top.hostTargets).toBeUndefined();
    expect(system.repositories).toContain("apps/shell");
    expect(system.repositories).toContain("apps/mobile");
    expect(system.repositories).not.toContain("workers/browser-data");
    expect(system.repositories).not.toContain("skills/memory");
    expect(system.manifest.top.hostTargets?.electron?.app).toBe("apps/shell");
    expect(system.manifest.top.hostTargets?.["react-native"]?.app).toBe("apps/mobile");
  });

  it("carries local startup and upstream tools once, in Base", () => {
    const files = new Set(distributions.base.files.map((file) => file.path));
    expect(files.has("about/new/index.tsx")).toBe(true);
    expect(files.has("about/help/index.tsx")).toBe(true);
    expect(files.has("skills/templates/SKILL.md")).toBe(true);
    // Built on Base rather than carrying a copy of it. The interesting case is
    // a repository the closure would otherwise pull back in: these two depend
    // on packages Base owns, so only stopping at the dependency's edge keeps
    // them out. A panel would prove nothing, since nothing depends on one.
    for (const role of ["personal", "system"] as const) {
      const carried = new Set(distributions[role].files.map((file) => file.path));
      expect(carried.has("about/help/index.tsx")).toBe(false);
      expect(carried.has("skills/templates/SKILL.md")).toBe(false);
      expect(distributions[role].repositories).not.toContain("packages/agentic-chat");
      expect(distributions[role].repositories).not.toContain("packages/runtime");
      expect(base.repositories).toEqual(
        expect.arrayContaining(["packages/agentic-chat", "packages/runtime"])
      );
    }
  });

  it.each(["base", "personal", "system"] as const)(
    "%s declares its own manifest, its dependencies, and no composed layers",
    (role) => {
      const prepared = distributions[role];
      const files = new Set(prepared.files.map((file) => file.path));
      expect(files.has("meta/vibestudio.yml")).toBe(true);
      expect(prepared.repositories).not.toContain("extensions/template-composer");
      expect(prepared.repositories).not.toContain("packages/template-composer");
      expect(prepared.manifest.top).not.toHaveProperty("templates");
      // Base stands alone; the other two say what they are built on, so an
      // installation acquires it rather than expecting to find it copied in.
      expect(prepared.manifest.dependencies.map((dependency) => dependency.url)).toEqual(
        role === "base" ? [] : ["git+https://github.com/panticonic/vibestudio-base.git"]
      );
      // An initial panel must resolve in the composed workspace, which is this
      // distribution's own repositories plus whatever its dependency supplies.
      const composed = new Set([...prepared.repositories, ...(role === "base" ? [] : provided)]);
      for (const panel of prepared.manifest.top.initPanels ?? []) {
        expect(composed.has(panel.source)).toBe(true);
      }
    }
  );
});
