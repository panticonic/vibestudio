import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectExactUserlandDependencyPins,
  collectHostReuseRangeFindings,
  collectStartupHostReuseFindings,
  runtimeImportPolicyForUnit,
} from "../scripts/check-userland-dependencies.mjs";
import { collectPackageManifestImportFindings } from "../scripts/lib/package-import-audit.mjs";
import {
  TERMINAL_SHIM_MODULE,
  TERMINAL_YOGA_WASM_MODULE,
  TERMINAL_WORKER_RUNTIME_EXTERNALS,
} from "../src/server/buildV2/platformModules.js";

describe("collectPackageManifestImportFindings", () => {
  it("allows the host terminal binding only for its declared runtime owner", async () => {
    const isTerminalWorker = (manifest) => manifest.terminal === true;
    const terminalOwner = {
      name: TERMINAL_SHIM_MODULE,
      kind: "package",
      manifest: {},
    };
    const terminalWorker = {
      name: "@workspace-workers/terminal",
      kind: "worker",
      manifest: { terminal: true },
    };
    const unrelatedPackage = {
      name: "@workspace/unrelated",
      kind: "package",
      manifest: {},
    };
    const policy = {
      isTerminalWorker,
      terminalShimModule: TERMINAL_SHIM_MODULE,
      terminalWorkerExternals: TERMINAL_WORKER_RUNTIME_EXTERNALS,
    };

    expect(TERMINAL_WORKER_RUNTIME_EXTERNALS).toEqual([TERMINAL_YOGA_WASM_MODULE]);
    expect(runtimeImportPolicyForUnit(terminalOwner, policy)).toEqual([TERMINAL_YOGA_WASM_MODULE]);
    expect(runtimeImportPolicyForUnit(terminalWorker, policy)).toEqual([TERMINAL_YOGA_WASM_MODULE]);
    expect(runtimeImportPolicyForUnit(unrelatedPackage, policy)).toEqual([]);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-terminal-import-audit-"));
    const packageRoot = path.join(root, "packages", "terminal-shim");
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    try {
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: terminalOwner.name, exports: { ".": "./src/index.ts" } })
      );
      fs.writeFileSync(
        path.join(packageRoot, "src", "index.ts"),
        `import ${JSON.stringify(TERMINAL_YOGA_WASM_MODULE)};\n`
      );
      await expect(
        collectPackageManifestImportFindings(packageRoot, root, {
          runtimeModuleSpecifiers: runtimeImportPolicyForUnit(terminalOwner, policy),
        })
      ).resolves.toEqual([]);
      await expect(
        collectPackageManifestImportFindings(packageRoot, root, {
          runtimeModuleSpecifiers: runtimeImportPolicyForUnit(unrelatedPackage, policy),
        })
      ).resolves.toEqual([
        expect.objectContaining({ dependency: TERMINAL_YOGA_WASM_MODULE, typeOnly: false }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks production import forms at the nearest package manifest boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-package-import-audit-"));
    const pkg = path.join(root, "packages", "fixture");
    const source = path.join(pkg, "src");
    fs.mkdirSync(source, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({
          name: "@workspace/fixture",
          exports: { ".": "./src/index.ts", "./testing": "./src/testing.test.ts" },
          imports: {
            "#internal/*": "./src/internal/*.ts",
            "#external": "@scope/external",
          },
          dependencies: {
            "@scope/runtime": "^1.0.0",
            "@scope/peer": "^1.0.0",
            "@scope/external": "^1.0.0",
          },
          peerDependencies: { "@scope/peer": "^1.0.0" },
          devDependencies: { "@scope/types": "^1.0.0", "@scope/type-only": "^1.0.0" },
        })
      );
      fs.writeFileSync(
        path.join(source, "index.ts"),
        [
          'import "@scope/runtime/subpath";',
          'export { value } from "@scope/peer/subpath";',
          'import type { Shape } from "@scope/type-only/types";',
          'type RuntimeShape = import("@scope/types/subpath").Shape;',
          'const late = await import("@scope/dynamic");',
          'const required = require("@scope/required/subpath");',
          'import "#internal/model";',
          'import "#external";',
        ].join("\n")
      );
      fs.writeFileSync(path.join(pkg, "src", "testing.test.ts"), 'import "@scope/test-only";\n');
      fs.mkdirSync(path.join(source, "internal"), { recursive: true });
      fs.writeFileSync(
        path.join(source, "internal", "model.ts"),
        'import "@scope/internal-missing";\n'
      );

      await expect(collectPackageManifestImportFindings(pkg, root)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            packageName: "@workspace/fixture",
            dependency: "@scope/dynamic",
            importer: "packages/fixture/src/index.ts",
            typeOnly: false,
          }),
          expect.objectContaining({
            packageName: "@workspace/fixture",
            dependency: "@scope/required",
            importer: "packages/fixture/src/index.ts",
            typeOnly: false,
          }),
          expect.objectContaining({
            packageName: "@workspace/fixture",
            dependency: "@scope/internal-missing",
            importer: "packages/fixture/src/internal/model.ts",
            typeOnly: false,
          }),
        ])
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires JSX's compiler runtime only when the owner supplies that transform", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-jsx-import-audit-"));
    const pkg = path.join(root, "fixture");
    fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
    try {
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "fixture", exports: { ".": "./src/index.tsx" } })
      );
      fs.writeFileSync(path.join(pkg, "src", "index.tsx"), "export const view = <main />;");
      await expect(
        collectPackageManifestImportFindings(pkg, root, { jsxRuntime: "react/jsx-runtime" })
      ).resolves.toEqual([expect.objectContaining({ dependency: "react", typeOnly: false })]);
      await expect(collectPackageManifestImportFindings(pkg, root)).resolves.toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps relative imports inside the nearest owning package boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-nested-package-audit-"));
    const outer = path.join(root, "outer");
    const inner = path.join(outer, "vendor", "inner");
    fs.mkdirSync(path.join(inner, "src"), { recursive: true });
    try {
      fs.writeFileSync(
        path.join(outer, "package.json"),
        JSON.stringify({ name: "outer", exports: { ".": "./index.ts" } })
      );
      fs.writeFileSync(path.join(outer, "index.ts"), 'import "./vendor/inner/src/index";');
      fs.writeFileSync(
        path.join(inner, "package.json"),
        JSON.stringify({ name: "inner", exports: { ".": "./src/index.ts" } })
      );
      fs.writeFileSync(path.join(inner, "src", "index.ts"), 'import "missing-inner-dep";');

      await expect(collectPackageManifestImportFindings(outer, root)).resolves.toEqual([]);
      await expect(collectPackageManifestImportFindings(inner, root)).resolves.toEqual([
        expect.objectContaining({ dependency: "missing-inner-dep", packageName: "inner" }),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectHostReuseRangeFindings", () => {
  it("requires the published Host range to fit entirely inside Base's runtime range", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dependency-policy-"));
    const host = path.join(root, "host");
    const base = path.join(root, "base");
    try {
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(path.join(base, "panels", "demo"), { recursive: true });
      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({ dependencies: { zod: "^3.24.1", react: "19.0.0" } })
      );
      fs.writeFileSync(
        path.join(base, "panels", "demo", "package.json"),
        JSON.stringify({ dependencies: { zod: "^3.25.76", react: "^19.0.0" } })
      );

      expect(collectHostReuseRangeFindings(host, base)).toEqual([
        {
          relative: "panels/demo/package.json",
          section: "dependencies",
          name: "zod",
          specifier: "^3.25.76",
          hostSpecifier: "^3.24.1",
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes dependencies whose exact bytes are owned by a Base patch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dependency-policy-"));
    const host = path.join(root, "host");
    const base = path.join(root, "base");
    try {
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(path.join(base, "packages", "patched"), { recursive: true });
      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({ dependencies: { "@scope/tool": "^1.0.0" } })
      );
      fs.writeFileSync(
        path.join(base, "packages", "patched", "package.json"),
        JSON.stringify({
          dependencies: { "@scope/tool": "1.2.3" },
          vibestudio: {
            dependencyResolution: {
              patches: { "@scope/tool@1.2.3": { path: "patch.diff", roots: ["@scope/tool"] } },
            },
          },
        })
      );

      expect(collectHostReuseRangeFindings(host, base)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectStartupHostReuseFindings", () => {
  it("requires every canonical startup dependency to be directly published by Host", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-startup-dependency-policy-"));
    const host = path.join(root, "host");
    const base = path.join(root, "base");
    try {
      fs.mkdirSync(host, { recursive: true });
      fs.mkdirSync(path.join(base, "meta"), { recursive: true });
      fs.mkdirSync(path.join(base, "apps", "shell"), { recursive: true });
      fs.mkdirSync(path.join(base, "panels", "chat"), { recursive: true });
      fs.mkdirSync(path.join(base, "workers", "agent-worker"), { recursive: true });
      fs.writeFileSync(
        path.join(base, "meta", "vibestudio.yml"),
        [
          "hostTargets:",
          "  electron:",
          "    app: apps/shell",
          "initPanels:",
          "  - source: panels/chat",
          "defaultAutomations:",
          "  welcome:",
          "    source: workers/agent-worker",
          "",
        ].join("\n")
      );
      fs.writeFileSync(
        path.join(base, "apps", "shell", "package.json"),
        JSON.stringify({
          name: "@workspace-apps/shell",
          vibestudio: { app: { target: "electron" } },
          dependencies: { react: "^19.0.0" },
        })
      );
      fs.writeFileSync(
        path.join(base, "panels", "chat", "package.json"),
        JSON.stringify({
          name: "@workspace-panels/chat",
          dependencies: { zod: "^3.25.76" },
          peerDependencies: { electron: "^45.0.0" },
          peerDependenciesMeta: { electron: { optional: true } },
        })
      );
      fs.writeFileSync(
        path.join(base, "workers", "agent-worker", "package.json"),
        JSON.stringify({
          name: "@workspace-workers/agent-worker",
          peerDependencies: { "@sinclair/typebox": "^0.27.12" },
        })
      );
      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({ dependencies: { react: "^19.0.0" } })
      );

      await expect(collectStartupHostReuseFindings(host, base)).resolves.toEqual([
        {
          unitPath: "panels/chat",
          missing: ["zod@^3.25.76"],
          incompatible: [],
          policies: [],
        },
        {
          unitPath: "workers/agent-worker",
          missing: ["@sinclair/typebox@^0.27.12"],
          incompatible: [],
          policies: [],
        },
      ]);

      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({
          dependencies: {
            react: "^19.0.0",
            zod: "^3.25.76",
            "@sinclair/typebox": "^0.27.12",
          },
        })
      );
      await expect(collectStartupHostReuseFindings(host, base)).resolves.toEqual([]);

      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({
          dependencies: {
            react: "^19.0.0",
            zod: "^3.25.76",
            "@sinclair/typebox": "^0.27.12",
            electron: "^44.0.0",
          },
        })
      );
      await expect(collectStartupHostReuseFindings(host, base)).resolves.toEqual([
        {
          unitPath: "panels/chat",
          missing: [],
          incompatible: ["electron@^44.0.0 (Base accepts ^45.0.0)"],
          policies: [],
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("governed native runtime pins", () => {
  it("accepts a new consumer of the exact Host release and rejects a different kernel or ordinary exact pin", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-native-pin-policy-"));
    const host = path.join(root, "host");
    const base = path.join(root, "base");
    try {
      fs.mkdirSync(host, { recursive: true });
      const consumer = path.join(base, "workers", "new-native-owner");
      fs.mkdirSync(consumer, { recursive: true });
      fs.writeFileSync(
        path.join(host, "package.json"),
        JSON.stringify({
          dependencies: {
            "@panticonic/pi-durable": "0.99.2-vibestudio.9",
            "@panticonic/pi-ai": "0.99.2-vibestudio.9",
          },
        })
      );
      fs.writeFileSync(
        path.join(consumer, "package.json"),
        JSON.stringify({
          dependencies: {
            "@panticonic/pi-durable": "0.99.2-vibestudio.9",
            "@panticonic/pi-ai": "0.99.2-vibestudio.8",
            "ordinary-library": "1.2.3",
          },
        })
      );
      expect(collectExactUserlandDependencyPins(base, host)).toEqual([
        {
          relative: "workers/new-native-owner/package.json",
          section: "dependencies",
          name: "@panticonic/pi-ai",
          specifier: "0.99.2-vibestudio.8",
        },
        {
          relative: "workers/new-native-owner/package.json",
          section: "dependencies",
          name: "ordinary-library",
          specifier: "1.2.3",
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
