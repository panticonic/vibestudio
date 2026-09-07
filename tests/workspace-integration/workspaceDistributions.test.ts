import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareWorkspaceDistribution } from "@vibestudio/workspace/distribution";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

const sourceRoot = process.env["VIBESTUDIO_USERLAND_ROOT"];
if (!sourceRoot)
  throw new Error("Workspace distribution acceptance requires the exact Base checkout");
const distributions = Object.fromEntries(
  (["base", "personal", "system"] as const).map((role) => [
    role,
    prepareWorkspaceDistribution({
      sourceRoot,
      manifestContent: readFileSync(
        path.join(sourceRoot, "meta/distributions", `${role}.yml`),
        "utf8"
      ),
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
    }),
  ])
);

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

  it.each(["base", "personal", "system"])(
    "%s carries local startup and upstream tools without composed layers",
    (role) => {
      const prepared = distributions[role]!;
      const files = new Set(prepared.files.map((file) => file.path));
      expect(files.has("meta/vibestudio.yml")).toBe(true);
      expect(files.has("about/new/index.tsx")).toBe(true);
      expect(files.has("skills/templates/SKILL.md")).toBe(true);
      expect(prepared.repositories).not.toContain("extensions/template-composer");
      expect(prepared.repositories).not.toContain("packages/template-composer");
      expect(prepared.manifest.top).not.toHaveProperty("templates");
      for (const panel of prepared.manifest.top.initPanels ?? []) {
        expect(prepared.repositories).toContain(panel.source);
      }
    }
  );
});
