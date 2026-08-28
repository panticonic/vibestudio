import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getExistingAppNodeModulesRoots } from "./runtimePaths.js";

describe("getExistingAppNodeModulesRoots", () => {
  it("uses package-owned dependencies without crossing the npm installation boundary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-paths-"));
    try {
      const ambient = path.join(root, "node_modules");
      const prefix = path.join(root, "prefix");
      const installRoot = path.join(prefix, "node_modules");
      const appRoot = path.join(installRoot, "@panticonic", "vibestudio-server");
      const owned = path.join(appRoot, "node_modules");
      for (const directory of [ambient, installRoot, owned]) {
        fs.mkdirSync(directory, { recursive: true });
      }

      expect(getExistingAppNodeModulesRoots(appRoot).map((entry) => path.resolve(entry))).toEqual([
        path.resolve(owned),
        path.resolve(installRoot),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not discover arbitrary ancestor dependencies for a source checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-paths-"));
    try {
      const appRoot = path.join(root, "checkout");
      const owned = path.join(appRoot, "node_modules");
      const ambient = path.join(root, "node_modules");
      fs.mkdirSync(owned, { recursive: true });
      fs.mkdirSync(ambient, { recursive: true });

      expect(getExistingAppNodeModulesRoots(appRoot).map((entry) => path.resolve(entry))).toEqual([
        path.resolve(owned),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
