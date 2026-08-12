import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildProviderInput } from "@vibestudio/shared/buildProvider";
import { writeProjectedMetroConfig } from "../workspace/extensions/react-native/metroConfig.js";

const temporaryRoots: string[] = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("React Native provider Metro projection", () => {
  it("uses only source and dependency paths supplied by Build V2", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rn-metro-projection-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "source", "apps", "mobile");
    const outputPath = path.join(root, "output");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(outputPath, { recursive: true });
    fs.writeFileSync(
      path.join(sourcePath, "native-module-policy.json"),
      JSON.stringify({
        blockedImports: {
          "react-native-keychain": ["src/services/pushNotifications.ts"],
        },
      })
    );
    const input: BuildProviderInput = {
      target: "react-native",
      unitName: "@workspace-apps/mobile",
      sourcePath,
      dependencyProjection: {
        nodeModulesPath: path.resolve("node_modules"),
        modules: {
          "@workspace-apps/mobile": sourcePath,
          "@vibestudio/mobile-webrtc": path.resolve("packages/mobile-webrtc"),
        },
      },
      effectiveVersion: "ev-test",
      manifest: {
        app: {
          target: "react-native",
          renderer: "App.tsx",
          nativeModulePolicy: "native-module-policy.json",
        },
      },
    };

    const configPath = writeProjectedMetroConfig(input, outputPath);
    const config = fs.readFileSync(configPath, "utf8");

    expect(config).toContain(JSON.stringify(sourcePath));
    expect(config).toContain(JSON.stringify(path.resolve("node_modules")));
    expect(config).toContain(JSON.stringify(path.resolve("packages/mobile-webrtc")));
    expect(config).toContain("react-native-keychain");
    expect(config).not.toContain("process.cwd");
    expect(config).not.toContain("VIBESTUDIO_REPO_ROOT");
    expect(config).not.toContain("workspaceRoot");
    expect(config).not.toContain("apps/mobile/metro.config.js");
    const loaded = require(configPath) as {
      resolver: { nodeModulesPaths: string[]; extraNodeModules: Record<string, string> };
    };
    expect(loaded.resolver.nodeModulesPaths).toEqual([path.resolve("node_modules")]);
    expect(loaded.resolver.extraNodeModules["@workspace-apps/mobile"]).toBe(sourcePath);
  });
});
