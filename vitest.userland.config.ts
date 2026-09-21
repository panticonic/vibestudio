import { defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";
import { vitestSharedConfig } from "./vitest.sharedConfig";
import { discoveredUserlandSourceAliases, hostSourceAliases } from "./vitest.sourceAliases";
import { userlandDependencyAliases } from "./vitest.userlandProjection";
import { prepareUserlandDependencyProjection } from "./scripts/lib/userland-dependency-projection";
import { exactPairTestsFor, excludedIntegrationTestsFor } from "./vitest.exactPairTests";
import { requireDevelopmentTemplateCheckouts } from "./src/dev/developmentTemplateConfig";
import { tsImport } from "tsx/esm/api";

/** The compiler options `scripts/config/userland/tsconfig.json` states are the
 * userland contract; the typecheck projects that exact file. Vitest transforms
 * the same sources in place, where esbuild's tsconfig lookup cannot find it. */
function userlandJsxTransform(appRoot: string): { jsx: "automatic" | "transform" } {
  const config = JSON.parse(
    fs.readFileSync(path.join(appRoot, "scripts/config/userland/tsconfig.json"), "utf8")
  ) as { compilerOptions?: { jsx?: string } };
  const jsx = config.compilerOptions?.jsx;
  if (jsx !== "react-jsx") {
    throw new Error(
      `userland tsconfig selects jsx "${jsx}"; teach vitest.userland.config.ts that transform`
    );
  }
  return { jsx: "automatic" };
}

/**
 * React, its renderer, and the JSX runtimes they share.
 *
 * Anything that reads or arms React's dispatcher has to come from one copy, so
 * these specifiers are resolved by the host aliases rather than the checkout's
 * dependency projection.
 */
const REACT_RUNTIME_SPECIFIER = /^react(-dom)?($|\/)/u;

function isReactRuntimeAlias(alias: { find: string | RegExp }): boolean {
  return typeof alias.find === "string"
    ? REACT_RUNTIME_SPECIFIER.test(alias.find)
    : REACT_RUNTIME_SPECIFIER.test(alias.find.source.replace(/^\^/u, "").replace(/\\/gu, ""));
}

export default defineConfig(async () => {
  // Vite externalizes workspace packages while bundling its config. Load this
  // source module through the same TypeScript resolver used by host scripts so
  // its package-export graph retains normal `.js`-to-`.ts` resolution.
  const { composeDevelopmentTemplateCheckouts } = await tsImport<
    typeof import("./src/dev/developmentTemplateComposition.js")
  >("./src/dev/developmentTemplateComposition.ts", import.meta.url);
  const template = process.env["VIBESTUDIO_USERLAND_TEMPLATE"] ?? "base";
  const selected = requireDevelopmentTemplateCheckouts(__dirname);
  const testSourceRoot = (selected.checkouts as Record<string, string | undefined>)[template];
  if (!testSourceRoot) {
    throw new Error(`Unknown VIBESTUDIO_USERLAND_TEMPLATE ${JSON.stringify(template)}`);
  }
  const composition = composeDevelopmentTemplateCheckouts(
    template === "base" ? [selected.checkouts.base] : [selected.checkouts.base, testSourceRoot]
  );
  process.once("exit", composition.release);
  const workspaceRoot = composition.root;
  const workspaceGlob = path.relative(__dirname, testSourceRoot).replaceAll(path.sep, "/");
  const projectedDependencies = await userlandDependencyAliases(__dirname, workspaceRoot);
  const dependencyProjection = await prepareUserlandDependencyProjection({
    appRoot: __dirname,
    workspaceRoot,
    includeDevelopmentDependencies: true,
  });
  const projectedNodePath = [
    dependencyProjection.nodeModulesDir,
    ...(process.env.NODE_PATH?.split(path.delimiter).filter(Boolean) ?? []),
  ].join(path.delimiter);
  process.env.NODE_PATH = projectedNodePath;
  const baseServer = vitestSharedConfig.test.server;
  const baseDeps = baseServer.deps;
  const baseInline = baseDeps.inline;
  return {
    ...vitestSharedConfig,
    // Userland is external source, not a package-manager/test-tool workspace.
    // Keep Vite's derived cache in the host checkout so running focused Base
    // tests can never add undeclared node_modules artifacts to a root template.
    cacheDir: path.resolve(__dirname, ".cache/vite/userland"),
    // esbuild derives the JSX transform from the tsconfig nearest each file.
    // Base carries no root tsconfig -- `scripts/config/userland` owns it and
    // the typecheck projects a copy per run -- so units without their own
    // config (apps/shell, panels, about, most of packages/) fell back to the
    // classic transform and every render threw "React is not defined". Read
    // the transform from the same authoritative config the typecheck compiles
    // with, so the runner and the compiler cannot disagree about it.
    esbuild: userlandJsxTransform(__dirname),
    server: {
      ...vitestSharedConfig.server,
      fs: {
        ...vitestSharedConfig.server?.fs,
        allow: [__dirname, workspaceRoot, testSourceRoot],
      },
    },
    resolve: {
      ...vitestSharedConfig.resolve,
      alias: [
        // Native test tooling is supplied by the host installation because
        // the content-addressed projection deliberately does not run package
        // lifecycle scripts. This is a test-runner effect, not userland code.
        {
          find: /^node-pty$/,
          replacement: path.resolve(__dirname, "node_modules/node-pty/lib/index.js"),
        },
        ...(dependencyProjection.nodeModulesDir
          ? [
              {
                find: /^(react-remove-scroll|react-remove-scroll-bar|use-sidecar|use-callback-ref)$/,
                replacement: path.join(dependencyProjection.nodeModulesDir, "$1"),
              },
            ]
          : []),
        // Declared Base dependencies are the exact userland environment under
        // test. Host aliases below are fallbacks for runner-only packages, not
        // permission to combine the host's dependency graph with Base's.
        ...projectedDependencies,
        {
          find: /^@exact-userland\/(.+)$/,
          replacement: `${workspaceRoot}/$1`,
        },
        // The host's own React is deliberately absent here. A renderer arms the
        // dispatcher on the React copy it imports, and the two renderers in play
        // disagree about where that is: `@testing-library/react` ships only with
        // the host, `react-reconciler` (Ink's) only in the checkout's
        // projection. Leaving the host's React aliases in place sent components
        // to one copy and a renderer to the other, and every hook read a null
        // dispatcher. The projection declares React, so it is the one copy.
        ...vitestSharedConfig.resolve.alias.filter((alias) => !isReactRuntimeAlias(alias)),
        {
          find: /^fast-xml-parser$/,
          replacement: path.resolve(__dirname, "node_modules/fast-xml-parser/src/fxp.js"),
        },
        ...(dependencyProjection.nodeModulesDir
          ? [
              {
                find: /^react-reconciler$/,
                replacement: path.join(
                  dependencyProjection.nodeModulesDir,
                  "react-reconciler/index.js"
                ),
              },
              {
                find: /^react-reconciler\/constants\.js$/,
                replacement: path.join(
                  dependencyProjection.nodeModulesDir,
                  "react-reconciler/constants.js"
                ),
              },
              {
                find: /^scheduler$/,
                replacement: path.join(dependencyProjection.nodeModulesDir, "scheduler/index.js"),
              },
              {
                find: /^unpdf\/pdfjs$/,
                replacement: path.join(dependencyProjection.nodeModulesDir, "unpdf/dist/pdfjs.mjs"),
              },
            ]
          : []),
        ...discoveredUserlandSourceAliases(dependencyProjection.units),
        ...hostSourceAliases(__dirname),
      ],
      // The terminal app renders through Ink, whose reconciler and scheduler
      // are React consumers the root `dedupe` list never named. Keep projected
      // dependency graphs on the runner's one React dispatcher.
      dedupe: [...vitestSharedConfig.resolve.dedupe, "react-reconciler", "scheduler"],
    },
    test: {
      ...vitestSharedConfig.test,
      name: `userland-${template}`,
      reporters: [
        "default",
        [
          path.resolve(__dirname, "scripts/runtime-foundation-evidence-reporter.mjs"),
          { project: "userland", root: __dirname },
        ],
      ],
      // Userland's full suite concurrently transforms several large dependency
      // graphs (TypeScript, provider SDKs, and panel barrels). A five-second
      // per-test budget makes otherwise-fast dynamic-import tests fail under
      // CPU contention even though they pass immediately in isolation.
      testTimeout: 30_000,
      env: {
        NODE_PATH: projectedNodePath,
        VIBESTUDIO_HOST_ROOT: __dirname,
        VIBESTUDIO_USERLAND_NODE_MODULES: dependencyProjection.nodeModulesDir,
        VIBESTUDIO_USERLAND_ROOT: workspaceRoot,
      },
      // Unbounded host-core parallelism oversubscribes the SQLite-heavy semantic
      // suites and can keep a worker from servicing Vitest's own RPC heartbeat.
      // Four workers retain broad parallel coverage without turning machine
      // core count into a liveness dependency.
      maxWorkers: 4,
      include: [
        `${workspaceGlob}/**/*.test.ts`,
        `${workspaceGlob}/**/*.test.tsx`,
        "tests/workspace-integration/**/*.test.ts",
        "tests/workspace-integration/**/*.test.tsx",
        ...exactPairTestsFor(template),
      ],
      exclude: [
        ...excludedIntegrationTestsFor(template),
        ...vitestSharedConfig.test.exclude,
        `${workspaceGlob}/apps/mobile/**`,
        `${workspaceGlob}/**/*.browser.test.ts`,
        `${workspaceGlob}/**/*.browser.test.tsx`,
        // These files use @workspace/test-runtime and run in workerd, not Vitest.
        `${workspaceGlob}/**/*.workerd.test.ts`,
      ],
      server: {
        ...baseServer,
        deps: {
          ...baseDeps,
          inline: [
            ...baseInline,
            // Userland npm dependencies live in the content-addressed build
            // cache. Inline that projection so Vite's React aliases/dedupe also
            // govern dependencies loaded from it.
            /\/derived-cache\/external-deps\//,
            /node_modules\/fast-xml-parser/,
          ],
        },
      },
    },
  };
});
