import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { computeHostDependencies } from "../scripts/build-server-npm-package.mjs";

const rootPackage = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const publicRuntimeDependencies = Object.fromEntries(
  Object.entries(rootPackage.dependencies).filter(
    ([, version]) => !version.startsWith("workspace:")
  )
);

describe("published npm dependency surface", () => {
  it("derives the server manifest from declared root runtime dependencies", () => {
    expect(computeHostDependencies()).toEqual(publicRuntimeDependencies);
  });

  it("never publishes Electron, which belongs to the natively packaged desktop", () => {
    expect(computeHostDependencies()).not.toHaveProperty("electron");
    expect(rootPackage.devDependencies.electron).toBeTruthy();
  });

  it("publishes every external native host runtime dependency", () => {
    expect(publicRuntimeDependencies).toMatchObject({
      "@vscode/ripgrep": "1.18.0",
      "@number0/iroh": "1.1.0",
      "node-pty": rootPackage.dependencies["node-pty"],
    });
  });

  it("does not publish unused host dependencies or type-only packages", () => {
    for (const dependency of [
      "@modelcontextprotocol/sdk",
      "chokidar",
      "p-limit",
      "pacote",
      "react-devtools-core",
      "@types/json-schema",
      "@types/ws",
    ]) {
      expect(publicRuntimeDependencies).not.toHaveProperty(dependency);
    }
    expect(rootPackage.devDependencies).toHaveProperty("@types/ws");
  });
});
