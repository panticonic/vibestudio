import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { exactUnitRoots } from "./exactUserlandRoot";

const repoRoot = process.cwd();

const migrationRoots = [
  "src",
  "packages/shared/src",
  "packages/extension/src",
  "apps/mobile/src",
  "apps/shell",
];

const approvedRawMainCalls = new Set([
  // Streaming Response boundary; `createTypedServiceClient` models JSON-style
  // call/return RPC, while invokeStream is intentionally carried by rpc.stream.
  "packages/extension/src/index.ts:extensions.invokeStream",
  // Generic workspace service resolver. The first hop resolves a dynamic
  // Durable Object target, and subsequent calls intentionally address that
  // workspace target rather than a typed host service table.
  "packages/shared/src/workspaceServiceRpc.ts:workers.resolveService",
  // Help-text/documentation string: evalSurfaceHelp renders an example showing
  // eval users the raw call form for a low-level method — not an actual call site.
  "src/server/internalDOs/evalSurfaceHelp.ts:workers.listSources",
  // Browser fallback shim: this builds a minimal shell bridge when preload did
  // not inject one. It intentionally stays on the raw envelope transport.
  "src/server/browserShellBridge.ts:panelTree.metadata",
  "src/server/browserShellBridge.ts:panelTree.focus",
]);

const rawMainCallPattern =
  /\.(?:call|stream)(?:<[^>]*>)?\(\s*["']main["']\s*,\s*["']([A-Za-z][A-Za-z0-9-]*)\.([A-Za-z0-9_.:-]+)["']/g;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "build") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walk(fullPath);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      yield fullPath;
    }
  }
}

describe("typed service client guard", () => {
  it("keeps migrated production surfaces free of raw literal main RPC calls", () => {
    const violations: string[] = [];

    for (const root of migrationRoots) {
      // Apps ship in the System template; host surfaces stay in this repository.
      const sourceRoots = root.startsWith("apps/")
        ? exactUnitRoots(root).map((unitRoot) => unitRoot.slice(0, -root.length - 1))
        : [repoRoot];
      for (const sourceRoot of sourceRoots)
      for (const file of walk(join(sourceRoot, root))) {
        const rel = relative(sourceRoot, file);
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(rawMainCallPattern)) {
          const serviceMethod = `${match[1]}.${match[2]}`;
          const key = `${rel}:${serviceMethod}`;
          if (!approvedRawMainCalls.has(key)) {
            violations.push(key);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps shared schema modules loadable through Node source imports", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "await import('@vibestudio/service-schemas/extensions');",
        ],
        { cwd: repoRoot, stdio: "pipe" }
      )
    ).not.toThrow();
  });
});
