import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertPackagedIrohBinding } from "../scripts/check-electron-package-boundary.mjs";

function touch(root: string, relative: string): void {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "fixture");
}

describe("packaged Iroh binding", () => {
  it("requires the JS binding and the exact target-native artifact", () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-packaged-iroh-"));
    touch(resources, "app.asar.unpacked/node_modules/@number0/iroh/index.js");
    expect(() => assertPackagedIrohBinding(resources, "darwin", 3)).toThrow(/native artifact/);
    touch(
      resources,
      "app.asar.unpacked/node_modules/@number0/iroh-darwin-arm64/iroh.darwin-arm64.node"
    );
    expect(() => assertPackagedIrohBinding(resources, "darwin", 3)).not.toThrow();
  });

  it("fails closed for a release target without an audited artifact", () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-packaged-iroh-"));
    touch(resources, "app.asar.unpacked/node_modules/@number0/iroh/index.js");
    expect(() => assertPackagedIrohBinding(resources, "darwin", "x64")).toThrow(
      /No packaged Iroh artifact contract/
    );
  });
});
