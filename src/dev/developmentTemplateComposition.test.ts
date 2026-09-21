import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTemplateManifestContent } from "@vibestudio/workspace/templateManifest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { composeDevelopmentTemplateCheckouts } from "./developmentTemplateComposition.js";

const roots: string[] = [];

function template(name: string, manifest: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibestudio-${name}-template-`));
  roots.push(root);
  fs.mkdirSync(path.join(root, "meta"), { recursive: true });
  fs.writeFileSync(path.join(root, "meta", "vibestudio.yml"), manifest);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("composeDevelopmentTemplateCheckouts", () => {
  it("materializes dependency-owned and dependent-owned units without changing their ownership", () => {
    const base = template(
      "base",
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: Base\n  repositories: [packages/base]\n`,
      { "packages/base/package.json": "{}", "packages/base/BASE.md": "base" }
    );
    const personal = template(
      "personal",
      `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: Personal\n  dependencies:\n    - url: git+https://example.test/base.git\n  repositories: [panels/tour]\n`,
      { "panels/tour/package.json": "{}", "panels/tour/PERSONAL.md": "personal" }
    );

    const composition = composeDevelopmentTemplateCheckouts([
      { checkout: base, url: "git+https://example.test/base.git" },
      { checkout: personal, url: "git+https://example.test/personal.git" },
    ]);
    roots.push(composition.root);
    const parsed = parseTemplateManifestContent(
      fs.readFileSync(path.join(composition.root, "meta", "vibestudio.yml"), "utf8"),
      WORKSPACE_SYSTEM_EPOCH
    );

    expect(parsed.inventory).toEqual({
      repositories: ["packages/base", "panels/tour"],
    });
    expect(parsed.dependencies).toEqual([{ url: "git+https://example.test/base.git" }]);
    expect(fs.readFileSync(path.join(composition.root, "packages/base/BASE.md"), "utf8")).toBe(
      "base"
    );
    expect(fs.readFileSync(path.join(composition.root, "panels/tour/PERSONAL.md"), "utf8")).toBe(
      "personal"
    );
  });
});
