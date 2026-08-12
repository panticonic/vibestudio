import { defineConfig } from "vitest/config";
import path from "node:path";
import { vitestSharedConfig } from "./vitest.sharedConfig";
import { workspaceSourceAliases } from "./vitest.sourceAliases";
import { userlandDependencyAliases } from "./vitest.userlandProjection";

export default defineConfig(async () => {
  const projectedDependencies = await userlandDependencyAliases(__dirname);
  const baseServer = vitestSharedConfig.test.server;
  const baseDeps = baseServer.deps;
  const baseInline = baseDeps.inline;
  return {
    ...vitestSharedConfig,
    resolve: {
      ...vitestSharedConfig.resolve,
      alias: [
        ...vitestSharedConfig.resolve.alias,
        ...workspaceSourceAliases(__dirname),
        ...projectedDependencies,
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
      // Unbounded host-core parallelism oversubscribes the SQLite-heavy semantic
      // suites and can keep a worker from servicing Vitest's own RPC heartbeat.
      // Four workers retain broad parallel coverage without turning machine
      // core count into a liveness dependency.
      maxWorkers: 4,
      include: [
        "workspace/**/*.test.ts",
        "workspace/**/*.test.tsx",
        "tests/workspace-integration/**/*.test.ts",
        "tests/workspace-integration/**/*.test.tsx",
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
          ],
        },
      },
    },
  };
});
