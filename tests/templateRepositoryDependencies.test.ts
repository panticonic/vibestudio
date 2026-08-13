import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateExactExternalDependencies } from "../scripts/validate-template-repository.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("template repository dependency versions", () => {
  it.each(["dependencies", "devDependencies", "peerDependencies"] as const)(
    "requires exact external %s",
    (field) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-deps-"));
      roots.push(root);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ [field]: { react: "^19.0.0", "@workspace/runtime": "workspace:*" } })
      );

      expect(() => validateExactExternalDependencies(root, ["package.json"])).toThrow(
        `package.json ${field}.react must use an exact version or workspace:*; got ^19.0.0`
      );
    }
  );

  it("accepts exact external versions and workspace packages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-deps-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { react: "19.0.0", "@workspace/runtime": "workspace:*" },
        peerDependencies: { "react-dom": "19.0.0" },
      })
    );

    expect(() => validateExactExternalDependencies(root, ["package.json"])).not.toThrow();
  });
});
