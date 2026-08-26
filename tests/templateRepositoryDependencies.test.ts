import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateExternalDependencySpecifiers } from "../scripts/validate-template-repository.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("template repository dependency versions", () => {
  it.each(["dependencies", "devDependencies"] as const)(
    "accepts compatible external %s ranges",
    (field) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-deps-"));
      roots.push(root);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ [field]: { react: "^19.0.0", "@workspace/runtime": "workspace:*" } })
      );

      expect(() => validateExternalDependencySpecifiers(root, ["package.json"])).not.toThrow();
    }
  );

  it("accepts peer compatibility ranges because they select no release bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-deps-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ peerDependencies: { react: "^19.0.0" } })
    );

    expect(() => validateExternalDependencySpecifiers(root, ["package.json"])).not.toThrow();
  });

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

    expect(() => validateExternalDependencySpecifiers(root, ["package.json"])).not.toThrow();
  });

  it.each(["file:../react", "git+https://example.test/react.git", "npm:other@1.0.0"])(
    "rejects non-registry acquisition specifier %s",
    (specifier) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-deps-"));
      roots.push(root);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { react: specifier } })
      );

      expect(() => validateExternalDependencySpecifiers(root, ["package.json"])).toThrow(
        `package.json dependencies.react must use a registry semver range or workspace:*; got ${specifier}`
      );
    }
  );
});
