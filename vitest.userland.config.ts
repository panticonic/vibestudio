import { defineConfig } from "vitest/config";
import path from "node:path";
import baseConfig from "./vitest.config";

const base = baseConfig as {
  test?: Record<string, unknown>;
  [key: string]: unknown;
};
const baseTest = base.test ?? {};
const baseServer = (baseTest.server as Record<string, unknown> | undefined) ?? {};
const baseDeps = (baseServer.deps as Record<string, unknown> | undefined) ?? {};
const baseInline = Array.isArray(baseDeps.inline) ? baseDeps.inline : [];

export default defineConfig({
  ...base,
  resolve: {
    ...((base.resolve as Record<string, unknown> | undefined) ?? {}),
    // The terminal app renders through Ink, whose reconciler and scheduler are
    // React consumers the root `dedupe` list never named. Userland carries its
    // own physical copies of both, so Ink's hooks ran against a second React
    // instance and every terminal surface rendered as an empty frame under
    // test — while working correctly outside it.
    dedupe: [
      ...(((base.resolve as { dedupe?: string[] } | undefined)?.dedupe ?? []) as string[]),
      "react-reconciler",
      "scheduler",
    ],
  },
  test: {
    ...baseTest,
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
