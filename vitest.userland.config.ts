import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import baseConfig from "./vitest.config";

const base = baseConfig as {
  test?: Record<string, unknown>;
  [key: string]: unknown;
};
const baseTest = base.test ?? {};
const baseServer = (baseTest.server as Record<string, unknown> | undefined) ?? {};
const baseDeps = (baseServer.deps as Record<string, unknown> | undefined) ?? {};
const baseInline = Array.isArray(baseDeps.inline) ? baseDeps.inline : [];
const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    // Userland's full suite concurrently transforms several large dependency
    // graphs (TypeScript, provider SDKs, and panel barrels). A five-second
    // per-test budget makes otherwise-fast dynamic-import tests fail under
    // CPU contention even though they pass immediately in isolation.
    testTimeout: 30_000,
    env: {
      ...((baseTest.env as Record<string, string> | undefined) ?? {}),
      // Production launchers always pin this boundary. Userland tests execute
      // with workspace/ as their cwd, so host-integration imports need the
      // same explicit application root to resolve sealed runtime artifacts.
      VIBESTUDIO_APP_ROOT: appRoot,
    },
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
          // Userland has its own physical node_modules tree. Externalizing any
          // React consumer from there bypasses Vite's root React aliases and
          // creates a second hook dispatcher (notably Jotai and Radix). Inline
          // that tree so every react/react-dom import joins the root graph.
          /\/workspace\/node_modules\//,
        ],
      },
    },
  },
});
