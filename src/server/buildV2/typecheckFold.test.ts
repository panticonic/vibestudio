import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { typecheckUnit } from "./typecheckFold.js";
import { createExactWorkspaceAuthorityEnvironment } from "./userlandAuthority.js";

/**
 * The push build-gate type-checks a unit against a BARE materialized source root
 * (the unit + its workspace-dep source subtrees — no node_modules, no
 * pnpm-workspace.yaml). These tests pin that `typecheckUnit` provisions module
 * resolution explicitly so `@workspace/*` (materialized subtree) AND external
 * deps (`node_modules`) resolve — the regression where it resolved NOTHING and
 * reported "Cannot find module" for every import would block all panel pushes.
 */
describe("typecheckUnit (push build-gate fold-in)", () => {
  let sourceRoot: string;
  let nodeModules: string;

  beforeAll(async () => {
    sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tcfold-src-"));
    nodeModules = await fsp.mkdtemp(path.join(os.tmpdir(), "tcfold-nm-"));

    // Unit under test: imports a workspace dep AND an external npm dep.
    await fsp.mkdir(path.join(sourceRoot, "panels/hello"), { recursive: true });
    await fsp.writeFile(
      path.join(sourceRoot, "panels/hello/package.json"),
      JSON.stringify({ name: "@workspace-panels/hello", type: "module" })
    );
    await fsp.writeFile(
      path.join(sourceRoot, "panels/hello/index.ts"),
      [
        `import { greet } from "@workspace/greeter";`,
        `import { extValue } from "ext-pkg";`,
        `import { hostValue } from "leaky-host";`,
        `export const message: string = greet(extValue);`,
        `export const hostMessage: string = hostValue;`,
      ].join("\n")
    );

    // Workspace dep, materialized as a source subtree — types come from its
    // `exports` pointing at source (exactly how real workspace packages ship).
    await fsp.mkdir(path.join(sourceRoot, "packages/greeter/src"), { recursive: true });
    await fsp.writeFile(
      path.join(sourceRoot, "packages/greeter/package.json"),
      JSON.stringify({
        name: "@workspace/greeter",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    await fsp.writeFile(
      path.join(sourceRoot, "packages/greeter/src/index.ts"),
      `export const greet = (who: string): string => "hi " + who;`
    );

    // External npm dep, resolvable only via an explicit node_modules root.
    await fsp.mkdir(path.join(nodeModules, "ext-pkg"), { recursive: true });
    await fsp.writeFile(
      path.join(nodeModules, "ext-pkg/package.json"),
      JSON.stringify({ name: "ext-pkg", version: "1.0.0", types: "index.d.ts" })
    );
    await fsp.writeFile(
      path.join(nodeModules, "ext-pkg/index.d.ts"),
      `export declare const extValue: string;`
    );

    // Product/ambient source can be pulled through node_modules by an export
    // that points at TypeScript. Its internal defect is not owned by the exact
    // workspace unit and must not leak into the report.
    await fsp.mkdir(path.join(nodeModules, "leaky-host"), { recursive: true });
    await fsp.writeFile(
      path.join(nodeModules, "leaky-host/package.json"),
      JSON.stringify({ name: "leaky-host", version: "1.0.0", exports: "./index.ts" })
    );
    await fsp.writeFile(
      path.join(nodeModules, "leaky-host/index.ts"),
      `export const hostValue: string = 42;`
    );

    await fsp.mkdir(path.join(sourceRoot, "types"), { recursive: true });
    await fsp.writeFile(
      path.join(sourceRoot, "types/assets.d.ts"),
      `declare module "*.css" { const classes: string; export default classes; }`
    );
  });

  afterAll(async () => {
    await fsp.rm(sourceRoot, { recursive: true, force: true });
    await fsp.rm(nodeModules, { recursive: true, force: true });
  });

  const deps = [
    { name: "@workspace-panels/hello", relativePath: "panels/hello" },
    { name: "@workspace/greeter", relativePath: "packages/greeter" },
  ];

  it("fails closed when the requested unit source is absent", async () => {
    const diagnostics = await typecheckUnit("panels/missing", sourceRoot, [], []);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: "tsc",
        severity: "error",
        file: "panels/missing",
        message: expect.stringContaining("Typecheck could not complete"),
      }),
    ]);
  });

  it("resolves @workspace/* (materialized subtree) and external deps (node_modules) — no false 'Cannot find module'", async () => {
    const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
    const cannotFind = diags.filter((d) => /Cannot find module/.test(d.message));
    expect(cannotFind).toEqual([]);
  });

  it("WITHOUT provisioning (the bug), the same unit reports 'Cannot find module' for both", async () => {
    // No workspace context (empty deps) + no node_modules → nothing resolves.
    const diags = await typecheckUnit("panels/hello", sourceRoot, [], []);
    const messages = diags.map((d) => d.message).join("\n");
    expect(messages).toMatch(/Cannot find module ['"]@workspace\/greeter['"]/);
    expect(messages).toMatch(/Cannot find module ['"]ext-pkg['"]/);
  });

  it("reports typecheck files in workspace-relative coordinates", async () => {
    const brokenPath = path.join(sourceRoot, "panels/hello/broken.ts");
    await fsp.writeFile(brokenPath, `export const count: number = "wrong";`);
    try {
      const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
      expect(diags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "tsc",
            file: "panels/hello/broken.ts",
          }),
        ])
      );
    } finally {
      await fsp.rm(brokenPath, { force: true });
    }
  });

  it("keeps ambient product-source defects out of an exact unit report", async () => {
    const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
    expect(diags.some((diagnostic) => diagnostic.file.includes("leaky-host"))).toBe(false);
  });

  it("accepts bundler asset imports (css, svg, png) without a checkout-provided types/assets.d.ts", async () => {
    const typesDir = path.join(sourceRoot, "types");
    const saved = path.join(sourceRoot, "types.saved");
    await fsp.rename(typesDir, saved);
    const sourcePath = path.join(sourceRoot, "panels/hello/with-assets.ts");
    await fsp.writeFile(
      sourcePath,
      `import "./styles.css";
import logo from "./logo.svg";
import photo from "./photo.png";
export const assets: string = logo + photo;`
    );
    await fsp.writeFile(path.join(sourceRoot, "panels/hello/styles.css"), `.root{}`);
    await fsp.writeFile(path.join(sourceRoot, "panels/hello/logo.svg"), `<svg/>`);
    await fsp.writeFile(path.join(sourceRoot, "panels/hello/photo.png"), "");
    try {
      const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
      expect(diags.filter((diagnostic) => diagnostic.file.endsWith("with-assets.ts"))).toEqual([]);
    } finally {
      await Promise.all(
        ["with-assets.ts", "styles.css", "logo.svg", "photo.png"].map((name) =>
          fsp.rm(path.join(sourceRoot, "panels/hello", name), { force: true })
        )
      );
      await fsp.rename(saved, typesDir);
    }
  });

  it("loads exact workspace-wide asset declarations for side-effect CSS imports", async () => {
    const sourcePath = path.join(sourceRoot, "panels/hello/with-style.ts");
    const stylePath = path.join(sourceRoot, "panels/hello/styles.css");
    await fsp.writeFile(sourcePath, `import "./styles.css"; export const styled = true;`);
    await fsp.writeFile(stylePath, `.root { color: red; }`);
    try {
      const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
      expect(diags.filter((diagnostic) => diagnostic.file.endsWith("with-style.ts"))).toEqual([]);
    } finally {
      await Promise.all([fsp.rm(sourcePath, { force: true }), fsp.rm(stylePath, { force: true })]);
    }
  });

  it("does not let a repository tsconfig weaken the publication baseline", async () => {
    const configPath = path.join(sourceRoot, "panels/hello/tsconfig.json");
    const unsafePath = path.join(sourceRoot, "panels/hello/unsafe-index.ts");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: {
          strict: false,
          noUncheckedIndexedAccess: false,
        },
      })
    );
    await fsp.writeFile(
      unsafePath,
      [
        "const values: Record<string, string> = {};",
        "export const value: string = values.missing;",
      ].join("\n")
    );
    try {
      const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
      expect(diags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "tsc",
            severity: "error",
            file: "panels/hello/unsafe-index.ts",
          }),
        ])
      );
    } finally {
      await Promise.all([fsp.rm(configPath, { force: true }), fsp.rm(unsafePath, { force: true })]);
    }
  });

  it("does not impose index-signature access syntax on workspace source", async () => {
    const sourcePath = path.join(sourceRoot, "panels/hello/css-module-shape.ts");
    await fsp.writeFile(
      sourcePath,
      [
        "declare const styles: Record<string, string>;",
        "declare function useClassName(value: string | undefined): void;",
        "useClassName(styles.app);",
      ].join("\n")
    );
    try {
      const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
      expect(diags.filter((diagnostic) => diagnostic.file.endsWith("css-module-shape.ts"))).toEqual(
        []
      );
    } finally {
      await fsp.rm(sourcePath, { force: true });
    }
  });

  it("folds missing capability requests into the exact-context build diagnostics", async () => {
    const authorityPath = path.join(sourceRoot, "panels/hello/authority-use.ts");
    await fsp.writeFile(
      authorityPath,
      [
        `declare function createTypedServiceClient(...args: unknown[]): any;`,
        `declare const workers: { resolveService(protocol: string): unknown };`,
        `const push = createTypedServiceClient("push", {}, () => undefined);`,
        `void push.send({ title: "hello" });`,
        `void workers.resolveService("example.notifications.v1");`,
      ].join("\n")
    );
    try {
      const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules], {
        manifest: {
          authority: {
            provides: [],
            requests: [
              {
                capability: "context.boundary",
                resource: { kind: "prefix", prefix: "" },
                tier: "critical",
                evidence: "intentional-broad",
              },
            ],
          },
        },
        environment: createExactWorkspaceAuthorityEnvironment({
          stateHash: "state:test",
          services: [
            {
              name: "local-notifications",
              protocols: ["example.notifications.v1"],
              source: "workers/notifications",
              action: "read notifications",
              presentation: { domain: "computer", verb: "see" },
              principals: ["code"],
              target: { kind: "worker", routePath: "/notifications" },
            },
          ],
          resolveCatalog: async (binding) => ({
            provider: {
              unitName: binding.source,
              source: binding.source,
              effectiveVersion: "ev-notifications",
              className: "worker",
            },
            methods: new Map(),
            digest: "catalog-notifications",
          }),
        }),
      });
      expect(diags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "authority",
            severity: "error",
            file: "panels/hello/package.json",
            message: expect.stringContaining("push.send"),
          }),
        ])
      );
      // Service dependencies are declared by stable protocol, so the diagnostic
      // names the protocol the code resolved and the manifest key that must
      // declare it — not the concrete provider capability, which stays derived
      // and separately granted.
      expect(diags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "authority",
            message: expect.stringContaining("example.notifications.v1"),
          }),
        ])
      );
      expect(diags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "authority",
            message: expect.stringContaining("vibestudio.authority.serviceRequests"),
          }),
        ])
      );
    } finally {
      await fsp.rm(authorityPath, { force: true });
    }
  });
});
