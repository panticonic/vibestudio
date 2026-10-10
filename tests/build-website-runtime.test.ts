import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { it, expect } from "vitest";
import { buildWebsiteRuntime } from "../scripts/build-website-runtime.js";

it("builds external workspace sources with package exports, host typings, and disposable declarations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-website-build-test-"));
  const workspaceRoot = path.join(root, "source");
  const outDir = path.join(root, "runtime");
  const write = (name: string, content: string) => {
    const destination = path.join(workspaceRoot, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  };
  try {
    write(
      "packages/ui/package.json",
      JSON.stringify({
        name: "@workspace/ui",
        type: "module",
        exports: { ".": "./index.ts" },
      })
    );
    write("packages/ui/index.ts", "export {};");
    write(
      "packages/runtime/package.json",
      JSON.stringify({
        name: "@workspace/runtime",
        type: "module",
        exports: { ".": "./src/panel/index.ts" },
        dependencies: {
          "@vibestudio/automation": "workspace:*",
          "@vibestudio/workspace-contracts": "workspace:*",
        },
      })
    );
    write(
      "packages/runtime/src/panel/index.ts",
      `import { AppVersionSchema } from "@vibestudio/workspace-contracts/appCompatibility";
export { canonicalCronExpression } from "@vibestudio/automation/cronSchedule";
export function isAppVersion(value: string): boolean {
  return AppVersionSchema.safeParse(value).success;
}
export interface DisposablePanel { [Symbol.asyncDispose](): Promise<void> }
export function createPanel(): DisposablePanel {
  return { async [Symbol.asyncDispose]() {} };
}`
    );
    write(
      "packages/react/package.json",
      JSON.stringify({
        name: "@workspace/react",
        type: "module",
        exports: { "./connection": "./src/WorkspaceConnection.tsx" },
        peerDependencies: { react: "^19.2.0" },
      })
    );
    write(
      "packages/react/src/WorkspaceConnection.tsx",
      `import { createElement } from "react";
export function WorkspaceConnection() { return createElement("button", null, "Connect"); }`
    );
    await buildWebsiteRuntime({ workspaceRoot, outDir });
    const module = await import(
      /* @vite-ignore */ pathToFileURL(path.join(outDir, "index.js")).href
    );
    expect(module.canonicalCronExpression("0 1 * * *")).toBe("0 1 * * *");
    expect(module.isAppVersion("0.1.84")).toBe(true);
    expect(module.isAppVersion("invalid")).toBe(false);
    await module.createPanel()[Symbol.asyncDispose]();
    expect(fs.readFileSync(path.join(outDir, "index.d.ts"), "utf8")).toContain(
      "Symbol.asyncDispose"
    );
    expect(fs.existsSync(path.join(workspaceRoot, "node_modules"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
