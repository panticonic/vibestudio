import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateTemplateRepository } from "../../scripts/validate-template-repository.js";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "template-manifest-validation-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "meta"));
  fs.mkdirSync(path.join(root, "panels/welcome"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "meta/vibestudio.yml"),
    `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: Fixture\n`
  );
  fs.writeFileSync(
    path.join(root, "panels/welcome/package.json"),
    JSON.stringify({ name, version: "1.0.0", vibestudio: { entry: "index.tsx" } })
  );
  fs.writeFileSync(
    path.join(root, "panels/welcome/index.tsx"),
    "export default function Welcome() { return null; }"
  );
  return root;
}
describe("template authored unit contracts", () => {
  it("rejects a source unit that installed build discovery would omit", () => {
    expect(() => validateTemplateRepository(fixture("@workspace-panels/examples-welcome"))).toThrow(
      'package.json name must be "@workspace-panels/welcome" for panels/welcome'
    );
  });
  it("admits the same canonical panel identity as installed build discovery", () => {
    expect(() => validateTemplateRepository(fixture("@workspace-panels/welcome"))).not.toThrow();
  });
});
