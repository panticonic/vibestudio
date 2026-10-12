import { defineConfig, type UserConfig } from "vitest/config";
import type { ProjectConfig } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { vitestSharedConfig } from "./vitest.sharedConfig";
import {
  discoveredUserlandSourceAliases,
  discoveredUserlandSourceMappings,
  hostSourceAliases,
} from "./vitest.sourceAliases";
import { userlandDependencyAliases } from "./vitest.userlandProjection";
import {
  prepareUserlandDependencyProjection,
  type UserlandDependencyProjection,
} from "./scripts/lib/userland-dependency-projection";
import { retireUserlandProjectionProcess } from "./scripts/lib/userland-projection-process-owner";
import { runWithOwnedCleanup } from "./scripts/lib/owned-cleanup.mjs";
import {
  exactPairTestPaths,
  exactPairTestsFor,
  excludedIntegrationTestsFor,
} from "./vitest.exactPairTests";
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

export default defineConfig(async (): Promise<UserConfig> => {
  // Vite externalizes workspace packages while bundling its config. Load this
  // source module through the same TypeScript resolver used by host scripts so
  // its package-export graph retains normal `.js`-to-`.ts` resolution.
  const { composeDevelopmentTemplateCheckouts } = (await tsImport(
    "./src/dev/developmentTemplateComposition.ts",
    import.meta.url
  )) as typeof import("./src/dev/developmentTemplateComposition.js");
  const template = process.env["VIBESTUDIO_USERLAND_TEMPLATE"] ?? "base";
  const selected = requireDevelopmentTemplateCheckouts(__dirname);
  const testSourceRoot = (selected.checkouts as Record<string, string | undefined>)[template];
  if (!testSourceRoot) {
    throw new Error(`Unknown VIBESTUDIO_USERLAND_TEMPLATE ${JSON.stringify(template)}`);
  }
  const composition = composeDevelopmentTemplateCheckouts(
    (template === "base"
      ? selected.sources.filter(({ id }) => id === "base")
      : selected.sources.filter(({ id }) => id === "base" || id === template)
    ).map(({ id, url }) => ({ checkout: selected.checkouts[id]!, url }))
  );
  const workspaceRoot = composition.root;
  const workspaceGlob = path.relative(__dirname, testSourceRoot).replaceAll(path.sep, "/");
  let dependencyProjection: UserlandDependencyProjection;
  try {
    dependencyProjection = await prepareUserlandDependencyProjection({
      appRoot: __dirname,
      workspaceRoot,
      includeDevelopmentDependencies: true,
      packageRelease: process.env["VIBESTUDIO_USERLAND_PACKAGE_RELEASE"],
    });
  } catch (error) {
    await runWithOwnedCleanup(
      () => Promise.reject(error),
      () => retireUserlandProjectionProcess([composition.release]),
      "Userland Vitest configuration cleanup failed"
    );
    throw error;
  }
  let retirement: Promise<void> | undefined;
  const retire = () =>
    (retirement ??= retireUserlandProjectionProcess([
      dependencyProjection.release,
      composition.release,
    ]));
  try {
    const projectedDependencies = userlandDependencyAliases(dependencyProjection);
    const projectedNodePath = [
      dependencyProjection.nodeModulesDir,
      ...(process.env["NODE_PATH"]?.split(path.delimiter).filter(Boolean) ?? []),
    ].join(path.delimiter);
    process.env["NODE_PATH"] = projectedNodePath;
    const baseServer = vitestSharedConfig.test.server;
    const baseDeps = baseServer.deps;
    const baseInline = baseDeps.inline;
    const cacheDir = path.resolve(__dirname, ".cache/vite/userland");
    const esbuild = userlandJsxTransform(__dirname);
    const userlandServer = {
      fs: {
        allow: [__dirname, workspaceRoot, testSourceRoot],
      },
    };
    const userlandVitestServer = {
      ...baseServer,
      deps: {
        ...baseDeps,
        inline: [
          ...baseInline,
          // Userland npm dependencies live in the content-addressed build
          // cache. Inline that projection so Vite's React aliases/dedupe also
          // govern dependencies loaded from it.
          /\/derived-cache\/external-deps\//,
          /\/\.cache\/userland-package-release-[^/]+\/node_modules\//,
          /node_modules\/fast-xml-parser/,
        ],
      },
    };
    const userlandResolve = {
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
        // disagree about where that is. The projection declares React, so it is
        // the one copy.
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
      // are React consumers the root `dedupe` list never named.
      dedupe: [...vitestSharedConfig.resolve.dedupe, "react-reconciler", "scheduler"],
    };
    const { globalSetup: _globalSetup, ...sharedProjectTest } = vitestSharedConfig.test;
    const projectTestBase: NonNullable<UserConfig["test"]> = {
      ...sharedProjectTest,
      exclude: [...vitestSharedConfig.test.exclude],
      setupFiles: [...vitestSharedConfig.test.setupFiles],
      reporters: [
        "default",
        [
          path.resolve(__dirname, "scripts/runtime-foundation-evidence-reporter.mjs"),
          { project: "userland", root: __dirname },
        ],
      ],
      testTimeout: 30_000,
      env: {
        NODE_PATH: projectedNodePath,
        VIBESTUDIO_HOST_ROOT: __dirname,
        VIBESTUDIO_USERLAND_NODE_MODULES: dependencyProjection.nodeModulesDir,
        VIBESTUDIO_USERLAND_ROOT: workspaceRoot,
        VIBESTUDIO_USERLAND_SOURCE_ALIASES: JSON.stringify(
          Object.fromEntries(
            discoveredUserlandSourceMappings(dependencyProjection.units).map(
              ({ find, replacement }) => [find, replacement]
            )
          )
        ),
      },
      server: userlandVitestServer,
    };
    const projectConfig = (test: Partial<ProjectConfig>) => ({
      configFile: false as const,
      root: __dirname,
      cacheDir,
      esbuild,
      server: userlandServer,
      resolve: userlandResolve,
      test: { ...projectTestBase, ...test },
    });
    return {
      ...vitestSharedConfig,
      plugins: [
        {
          name: "release-userland-test-environment",
          async closeBundle() {
            await retire();
          },
        },
      ],
      // Userland is external source, not a package-manager/test-tool workspace.
      // Keep Vite's derived cache in the host checkout so running focused Base
      // tests can never add undeclared node_modules artifacts to a root template.
      cacheDir,
      // esbuild derives the JSX transform from the tsconfig nearest each file.
      // Base carries no root tsconfig -- `scripts/config/userland` owns it and
      // the typecheck projects a copy per run -- so units without their own
      // config (apps/shell, panels, about, most of packages/) fell back to the
      // classic transform and every render threw "React is not defined". Read
      // the transform from the same authoritative config the typecheck compiles
      // with, so the runner and the compiler cannot disagree about it.
      esbuild,
      server: userlandServer,
      resolve: userlandResolve,
      test: {
        ...projectTestBase,
        // The core Vitest project owns this once for the complete invocation;
        // its temp-root setup mutates process TMPDIR and must not race a second
        // per-project owner.
        globalSetup: [...vitestSharedConfig.test.globalSetup],
        // Exact host/template pair tests include native build and workspace
        // composition work. Running those alongside the four-worker template
        // suite contends for the same compiler/CPU capacity and can push an
        // otherwise ~20s real build past its test-runner budget. Keep the pair
        // lane exclusive, then run ordinary template and workspace-integration
        // coverage at the existing four-worker limit. Inline project configs
        // share the already-prepared dependency projection and cleanup owner.
        projects: [
          projectConfig({
            name: `userland-${template}-native-pairs`,
            sequence: { groupOrder: 0 },
            poolOptions: { forks: { singleFork: true } },
            include: exactPairTestsFor(template),
            exclude: [...vitestSharedConfig.test.exclude],
          }),
          projectConfig({
            name: `userland-${template}-template`,
            sequence: { groupOrder: 1 },
            include: [
              `${workspaceGlob}/**/*.test.ts`,
              `${workspaceGlob}/**/*.test.tsx`,
              "tests/workspace-integration/**/*.test.ts",
              "tests/workspace-integration/**/*.test.tsx",
            ],
            exclude: [
              ...exactPairTestPaths,
              ...excludedIntegrationTestsFor(template),
              ...vitestSharedConfig.test.exclude,
              `${workspaceGlob}/apps/mobile/**`,
              `${workspaceGlob}/**/*.browser.test.ts`,
              `${workspaceGlob}/**/*.browser.test.tsx`,
              // These files use @workspace/test-runtime and run in workerd,
              // not Vitest.
              `${workspaceGlob}/**/*.workerd.test.ts`,
            ],
          }),
        ],
        name: `userland-${template}`,
        include: [],
        exclude: [...vitestSharedConfig.test.exclude],
        // Ordinary projects retain the broad userland suite's four-worker
        // limit. The native-pair project narrows its own pool to one fork.
        maxWorkers: 4,
      },
    };
  } catch (error) {
    await runWithOwnedCleanup(
      () => Promise.reject(error),
      () => retire(),
      "Userland Vitest configuration cleanup failed"
    );
    throw error;
  }
});
