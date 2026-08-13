import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NODE_ESM_COMPAT_BANNER, SERVER_ESM_BANNER } from "./build-artifact-contracts.mjs";
import { assertHostNativeDependencies } from "./native-host-dependencies.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const contracts = [
  {
    path: "dist/cli/client.mjs",
    runtime: "standalone Node CLI",
    format: "esm",
    mustContain: [NODE_ESM_COMPAT_BANNER],
  },
  {
    path: "dist/main.cjs",
    runtime: "Electron main",
    format: "cjs",
    mustContain: ['require("electron")'],
    forbidden: [
      {
        pattern: "throw Error('Dynamic require of \"",
        reason:
          "CJS Electron main should have native require, not esbuild's ESM dynamic require fallback.",
      },
    ],
  },
  {
    path: "dist/server-electron.cjs",
    runtime: "Electron utilityProcess",
    format: "cjs",
    mustContain: [
      '"use strict"',
      'import("esbuild-svelte")',
      'require("node-pty")',
      'require("@vscode/ripgrep")',
    ],
    forbidden: [
      {
        pattern: "throw Error('Dynamic require of \"",
        reason: "CJS utility-process server should have native require.",
      },
      {
        pattern: "node_modules/node-pty/lib/unixTerminal.js",
        reason:
          "node-pty must stay external so its loader resolves pty.node relative to the installed package.",
      },
      {
        pattern: "node_modules/@vscode/ripgrep/lib/index.js",
        reason:
          "@vscode/ripgrep must stay external so import.meta.url resolves its installed platform binary.",
      },
    ],
  },
  {
    path: "dist/server.mjs",
    runtime: "standalone Node server",
    format: "esm",
    mustContain: [SERVER_ESM_BANNER, 'import("esbuild-svelte")'],
    mustContainAny: [['from "node-pty"', 'from"node-pty"']],
    forbidden: [
      {
        pattern: "node_modules/node-pty/lib/unixTerminal.js",
        reason:
          "node-pty must stay external so its loader resolves pty.node relative to the installed package.",
      },
      {
        pattern: "node_modules/@vscode/ripgrep/lib/index.js",
        reason: "@vscode/ripgrep must stay external so it resolves its installed platform binary.",
      },
    ],
  },
  {
    path: "src/server/buildV2/builder.ts",
    runtime: "runtime workspace builder",
    forbidden: [
      {
        pattern: 'path.join(process.cwd(), "package.json")',
        reason:
          "Runtime build dependencies must resolve from the explicit app roots, not the launch directory.",
      },
    ],
  },
  {
    path: "packages/shared/src/npmInstaller.ts",
    runtime: "runtime npm installer",
    forbidden: [
      {
        pattern: "process.cwd()",
        reason:
          "The bundled npm CLI must resolve from the exact application root, not the launch directory.",
      },
    ],
  },
  {
    path: "packages/process-adapter/src/index.ts",
    runtime: "runtime process adapter",
    forbidden: [
      {
        pattern: "process.cwd()",
        reason:
          "Optional runtime peers must resolve from the installed adapter, not the launch directory.",
      },
    ],
  },
  {
    path: "src/server/headlessHostManager.ts",
    runtime: "headless-host launcher",
    forbidden: [
      {
        pattern: "process.cwd()",
        reason:
          "Headless-host artifacts and overrides must be exact paths, not launch-directory-relative paths.",
      },
    ],
  },
  {
    path: "dist/internal-do.bundle.mjs",
    runtime: "workerd/browser Durable Object bundle",
    format: "esm",
    forbidden: [
      {
        pattern: '__require("process")',
        reason: "workerd/browser bundles cannot depend on Node's process module.",
      },
      {
        pattern: 'require("process")',
        reason: "workerd/browser bundles cannot depend on Node's process module.",
      },
      {
        pattern: "throw Error('Dynamic require of \"",
        reason: "workerd/browser bundles cannot rely on dynamic CommonJS require.",
      },
    ],
  },
  {
    path: "dist/browserTransport.js",
    runtime: "browser panel transport",
    format: "iife",
    forbidden: [
      {
        pattern: '__require("process")',
        reason: "browser bundles cannot depend on Node's process module.",
      },
      {
        pattern: 'require("process")',
        reason: "browser bundles cannot depend on Node's process module.",
      },
      {
        pattern: "throw Error('Dynamic require of \"",
        reason: "browser bundles cannot rely on dynamic CommonJS require.",
      },
    ],
  },
  {
    path: "dist/browserPrivacyPreload.cjs",
    runtime: "host-owned browser privacy preload",
    format: "cjs",
    mustContain: ["vibestudio:browser-privacy:call", "contextBridge"],
    forbidden: [
      {
        pattern: "nodeIntegration: true",
        reason: "The protected-data presentation must remain a narrow context-bridge surface.",
      },
    ],
  },
  {
    path: "dist/browserPrivacy.html",
    runtime: "host-owned browser privacy document",
    mustContain: ['id="content"', 'id="confirm"'],
    forbidden: [
      {
        pattern: "<script",
        reason: "The protected-data document executes only its packaged sandboxed preload.",
      },
    ],
  },
  {
    path: "packages/extension-host/dist/index.js",
    runtime: "Node ESM package",
    format: "esm",
    mustContain: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ],
  },
  {
    path: "packages/extension-host/dist/childRuntime.js",
    runtime: "Node forked extension child runtime",
    format: "esm",
    mustContain: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ],
    forbidden: [
      {
        pattern: 'from "electron"',
        reason: "the forked extension child runtime must stay independent of Electron.",
      },
      {
        pattern: 'require("electron")',
        reason: "the forked extension child runtime must stay independent of Electron.",
      },
    ],
  },
  {
    path: "packages/process-adapter/dist/index.js",
    runtime: "Node ESM package",
    format: "esm",
    mustContain: ["createRequire(process.execPath)"],
  },
];

const importSmokes = [
  {
    path: "packages/extension-host/dist/index.js",
    exportName: "ExtensionHost",
  },
  {
    path: "packages/process-adapter/dist/index.js",
    exportName: "createProcessAdapter",
  },
];

const executableSmokes = [
  {
    path: "dist/cli/client.mjs",
    args: ["--help"],
    mustContain: "Usage:",
  },
];

function readArtifact(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`${relativePath} does not exist. Run pnpm build first.`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function checkContract(contract) {
  const source = readArtifact(contract.path);
  for (const expected of contract.mustContain ?? []) {
    if (!source.includes(expected)) {
      throw new Error(
        `${contract.path} (${contract.runtime}) is missing expected text: ${expected}`
      );
    }
  }
  for (const alternatives of contract.mustContainAny ?? []) {
    if (!alternatives.some((expected) => source.includes(expected))) {
      throw new Error(
        `${contract.path} (${contract.runtime}) is missing every expected alternative: ${alternatives.join(
          ", "
        )}`
      );
    }
  }
  for (const entry of contract.forbidden ?? []) {
    if (source.includes(entry.pattern)) {
      throw new Error(`${contract.path} (${contract.runtime}) violates contract: ${entry.reason}`);
    }
  }
}

async function runImportSmoke(smoke) {
  const absolutePath = path.join(repoRoot, smoke.path);
  const mod = await import(pathToFileURL(absolutePath).href);
  if (!(smoke.exportName in mod)) {
    throw new Error(`${smoke.path} did not export ${smoke.exportName}`);
  }
}

function runExecutableSmoke(smoke) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, smoke.path), ...smoke.args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${smoke.path} failed its executable smoke (exit ${result.status}):\n${result.stderr || result.stdout}`
    );
  }
  if (!result.stdout.includes(smoke.mustContain)) {
    throw new Error(`${smoke.path} executable smoke did not print: ${smoke.mustContain}`);
  }
}

for (const contract of contracts) {
  checkContract(contract);
}

for (const smoke of importSmokes) {
  await runImportSmoke(smoke);
}

for (const smoke of executableSmokes) {
  runExecutableSmoke(smoke);
}

assertHostNativeDependencies({ cwd: repoRoot });

if (process.env.NODE_ENV === "production") {
  const maps = fs
    .readdirSync(path.join(repoRoot, "dist"), { recursive: true })
    .filter((entry) => String(entry).endsWith(".map"));
  if (maps.length > 0) {
    throw new Error(`Production dist contains source maps: ${maps.join(", ")}`);
  }
}

console.log(
  `[build-artifacts] ${contracts.length} contracts checked, ${importSmokes.length} import smokes, ${executableSmokes.length} executable smokes, and 3 host runtime contracts passed.`
);
