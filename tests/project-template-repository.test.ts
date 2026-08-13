import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  applyReviewedTemplateRepositoryExchange,
  applyTemplateRepositoryExchange,
  parseTemplateExchangeArguments,
  planTemplateRepositoryExchange,
} from "@vibestudio/workspace/templateRepositoryExchange";

const roots: string[] = [];

function fixture(): { workspace: string; checkout: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "template-exchange-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const checkout = path.join(root, "checkout");
  for (const directory of [workspace, checkout]) {
    fs.mkdirSync(path.join(directory, "meta"), { recursive: true });
    fs.mkdirSync(path.join(directory, "apps", "one"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "meta", "template.yml"),
      [
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}`,
        "template:",
        "  name: Test",
        "  description: Test template",
        "  repositories:",
        "    - apps/one",
        "  files:",
        "    - package.json",
        "apps:",
        "  - source: apps/one",
        "",
      ].join("\n")
    );
    fs.writeFileSync(path.join(directory, "apps", "one", "package.json"), "one\n");
    fs.writeFileSync(path.join(directory, "package.json"), "root\n");
  }
  fs.mkdirSync(path.join(checkout, ".git"));
  return { workspace, checkout };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("template repository exchange", () => {
  it("establishes an exact baseline and exports only the declared projection", () => {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.checkout, "notes.txt"), "checkout-only\n");
    const plan = planTemplateRepositoryExchange({ ...fx, direction: "export" });
    expect(plan.conflicts).toEqual([]);
    expect(plan.untouched).toContain("notes.txt");
    const receipt = applyTemplateRepositoryExchange(plan);
    expect(receipt.written.map((entry) => entry.path)).toEqual(["meta/vibestudio.yml"]);
    expect(receipt.baselineAfter).toMatch(/^[a-f0-9]{64}$/u);
    expect(fs.readFileSync(path.join(fx.checkout, "notes.txt"), "utf8")).toBe("checkout-only\n");
  });

  it("preserves one-sided checkout edits until an explicit import", () => {
    const fx = fixture();
    applyTemplateRepositoryExchange(planTemplateRepositoryExchange({ ...fx, direction: "export" }));
    fs.writeFileSync(path.join(fx.checkout, "apps", "one", "package.json"), "checkout edit\n");
    const exportPlan = planTemplateRepositoryExchange({ ...fx, direction: "export" });
    expect(exportPlan.paths.find((entry) => entry.path === "apps/one/package.json")?.status).toBe(
      "target-changed"
    );
    applyTemplateRepositoryExchange(exportPlan);
    expect(fs.readFileSync(path.join(fx.workspace, "apps", "one", "package.json"), "utf8")).toBe(
      "one\n"
    );
    const importPlan = planTemplateRepositoryExchange({ ...fx, direction: "import" });
    expect(importPlan.paths.find((entry) => entry.path === "apps/one/package.json")?.status).toBe(
      "update"
    );
    applyTemplateRepositoryExchange(importPlan);
    expect(fs.readFileSync(path.join(fx.workspace, "apps", "one", "package.json"), "utf8")).toBe(
      "checkout edit\n"
    );
  });

  it("refuses divergent edits without overwriting either side", () => {
    const fx = fixture();
    applyTemplateRepositoryExchange(planTemplateRepositoryExchange({ ...fx, direction: "export" }));
    const relative = path.join("apps", "one", "package.json");
    fs.writeFileSync(path.join(fx.workspace, relative), "semantic edit\n");
    fs.writeFileSync(path.join(fx.checkout, relative), "checkout edit\n");
    const plan = planTemplateRepositoryExchange({ ...fx, direction: "export" });
    expect(plan.conflicts).toEqual(["apps/one/package.json"]);
    expect(() => applyTemplateRepositoryExchange(plan)).toThrow("has conflicts");
    expect(fs.readFileSync(path.join(fx.workspace, relative), "utf8")).toBe("semantic edit\n");
    expect(fs.readFileSync(path.join(fx.checkout, relative), "utf8")).toBe("checkout edit\n");
  });

  it("requires the reviewed exact plan to remain current", () => {
    const fx = fixture();
    const plan = planTemplateRepositoryExchange({ ...fx, direction: "export" });
    fs.writeFileSync(path.join(fx.workspace, "package.json"), "changed after review\n");
    expect(() => applyTemplateRepositoryExchange(plan)).toThrow("changed after review");
  });

  it("requires a prior exact operation identity for standalone apply", () => {
    const fx = fixture();
    const plan = planTemplateRepositoryExchange({ ...fx, direction: "export" });
    expect(() =>
      parseTemplateExchangeArguments([
        "--workspace",
        fx.workspace,
        "--checkout",
        fx.checkout,
        "--direction",
        "export",
        "--apply",
      ])
    ).toThrow("--apply and --operation-id must be provided together");
    expect(() => applyReviewedTemplateRepositoryExchange(plan, "0".repeat(64))).toThrow(
      "operation changed after review"
    );
    expect(applyReviewedTemplateRepositoryExchange(plan, plan.operationId).operationId).toBe(
      plan.operationId
    );
  });

  it("rejects physically overlapping roots reached through a symlink alias", () => {
    const fx = fixture();
    const alias = path.join(path.dirname(fx.checkout), "checkout-alias");
    fs.symlinkSync(fx.checkout, alias, "dir");
    expect(() =>
      planTemplateRepositoryExchange({
        workspace: alias,
        checkout: fx.checkout,
        direction: "export",
      })
    ).toThrow("must be separate trees");
  });

  it("does not invent a flattened runtime for a contribution template", () => {
    const fx = fixture();
    const manifestPath = path.join(fx.workspace, "meta", "template.yml");
    fs.appendFileSync(
      manifestPath,
      ["templates:", "  use:", "    - url: git+https://example.test/base.git", ""].join("\n")
    );
    fs.copyFileSync(manifestPath, path.join(fx.checkout, "meta", "template.yml"));
    const plan = planTemplateRepositoryExchange({ ...fx, direction: "export" });
    expect(plan.projection).not.toContain("meta/vibestudio.yml");
    expect(plan.paths).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "meta/vibestudio.yml" })])
    );
  });
});
