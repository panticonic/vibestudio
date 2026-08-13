import { defineConfig } from "vitest/config";
import path from "node:path";
import { vitestSharedConfig } from "./vitest.sharedConfig";
import { discoveredUserlandSourceAliases, workspaceSourceAliases } from "./vitest.sourceAliases";
import { userlandDependencyAliases } from "./vitest.userlandProjection";
import { prepareUserlandDependencyProjection } from "./scripts/lib/userland-dependency-projection";
import { exactPairTests } from "./vitest.exactPairTests";

export default defineConfig(async () => {
  const workspaceRootArgument = process.env["VIBESTUDIO_USERLAND_ROOT"];
  if (!workspaceRootArgument) {
    throw new Error("VIBESTUDIO_USERLAND_ROOT must name the exact Base checkout under test");
  }
  const workspaceRoot = path.resolve(workspaceRootArgument);
  const workspaceGlob = path.relative(__dirname, workspaceRoot).replaceAll(path.sep, "/");
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
    server: {
      ...vitestSharedConfig.server,
      fs: {
        ...vitestSharedConfig.server?.fs,
        allow: [__dirname, workspaceRoot],
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
        ...vitestSharedConfig.resolve.alias,
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
        ...workspaceSourceAliases(__dirname, workspaceRoot),
      ],
      // The terminal app renders through Ink, whose reconciler and scheduler
      // are React consumers the root `dedupe` list never named. Keep projected
      // dependency graphs on the runner's one React dispatcher.
      dedupe: [...vitestSharedConfig.resolve.dedupe, "react-reconciler", "scheduler"],
    },
    test: {
      ...vitestSharedConfig.test,
      name: "userland",
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
        ...exactPairTests,
      ],
      exclude: [
        ...vitestSharedConfig.test.exclude,
        `${workspaceGlob}/apps/mobile/**`,
        `${workspaceGlob}/**/*.browser.test.ts`,
        `${workspaceGlob}/**/*.browser.test.tsx`,
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
