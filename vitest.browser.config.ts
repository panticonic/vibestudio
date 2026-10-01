import { defineConfig, type UserConfig } from "vitest/config";
import path from "node:path";
import { discoveredUserlandSourceAliases, hostSourceAliases } from "./vitest.sourceAliases";
import { userlandDependencyAliases } from "./vitest.userlandProjection";
import { prepareUserlandDependencyProjection } from "./scripts/lib/userland-dependency-projection";
import { tsImport } from "tsx/esm/api";
import { requireDevelopmentTemplateCheckouts } from "./src/dev/developmentTemplateConfig";

// Browser-mode test project. Opened Radix overlays (Dialog/DropdownMenu/Popover/
// HoverCard) exercise externalized CJS sidecars that do not faithfully model a
// browser bundle under jsdom. A real browser bundles one React dispatcher, so
// these tests run here; the jsdom suite excludes *.browser.test.tsx.

export default defineConfig(async (): Promise<UserConfig> => {
  const template = process.env["VIBESTUDIO_USERLAND_TEMPLATE"] ?? "base";
  const selected = requireDevelopmentTemplateCheckouts(__dirname);
  const testSourceRoot = (selected.checkouts as Record<string, string | undefined>)[template];
  if (!testSourceRoot) throw new Error(`Unknown browser-test template ${JSON.stringify(template)}`);
  const { composeDevelopmentTemplateCheckouts } = (await tsImport(
    "./src/dev/developmentTemplateComposition.ts",
    import.meta.url
  )) as typeof import("./src/dev/developmentTemplateComposition.js");
  const composition = composeDevelopmentTemplateCheckouts(
    selected.sources
      .filter(({ id }) => id === "base" || id === template)
      .map(({ id, url }) => ({ checkout: selected.checkouts[id]!, url }))
  );
  process.once("exit", composition.release);
  const workspaceRoot = composition.root;
  const dependencyProjection = await prepareUserlandDependencyProjection({
    appRoot: __dirname,
    workspaceRoot,
    includeDevelopmentDependencies: true,
  });
  process.once("exit", dependencyProjection.release);
  return {
    cacheDir: path.join(workspaceRoot, ".vite-browser"),
    plugins: [
      {
        name: "release-userland-browser-test-environment",
        closeBundle() {
          dependencyProjection.release();
          composition.release();
          process.removeListener("exit", composition.release);
          process.removeListener("exit", dependencyProjection.release);
        },
      },
    ],
    esbuild: { jsx: "automatic" },
    resolve: {
      alias: [
        ...userlandDependencyAliases(dependencyProjection),
        ...discoveredUserlandSourceAliases(dependencyProjection.units),
        ...hostSourceAliases(__dirname),
      ],
      dedupe: ["react", "react-dom"],
    },
    server: {
      // This runner verifies one immutable template composition. It does not
      // need watchers for the host checkout or packaged release directories.
      watch: null,
      fs: {
        // Read tests from their exact source checkout; dependencies, composed
        // modules, caches and screenshots remain owned by the host.
        allow: [__dirname, workspaceRoot, testSourceRoot],
      },
    },
    test: {
      globals: true,
      include: [
        `${path
          .relative(__dirname, testSourceRoot)
          .replaceAll(path.sep, "/")}/**/*.browser.test.{ts,tsx}`,
        "packages/**/*.browser.test.tsx",
        "src/**/*.browser.test.tsx",
      ],
      exclude: ["**/node_modules/**", "dist", "apps/mobile/**"],
      browser: {
        enabled: true,
        provider: "playwright",
        headless: true,
        screenshotDirectory: path.resolve(
          __dirname,
          "node_modules/.cache/vitest/browser-screenshots"
        ),
        instances: [{ browser: "chromium" }],
      },
    },
  };
});
