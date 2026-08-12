import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BuildProviderInput, BuildProviderOutput } from "@vibestudio/shared/buildProvider";
import { contentTypeForPath } from "@vibestudio/shared/contentType";
import { writeProjectedMetroConfig } from "./metroConfig.js";

export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/react-native": Api;
  }
}

interface ArtifactFile {
  filePath: string;
  tempDir: string;
}

const ownedTempDirs = new Set<string>();

export async function activate() {
  const artifactFiles = new Map<string, ArtifactFile>();
  const tempDirRefs = new Map<string, number>();
  return {
    async build(input: BuildProviderInput): Promise<BuildProviderOutput> {
      if (input.target !== "react-native") {
        throw new Error(`react-native provider cannot build target: ${input.target}`);
      }
      const appManifest =
        input.manifest["app"] && typeof input.manifest["app"] === "object"
          ? (input.manifest["app"] as Record<string, unknown>)
          : input.manifest;
      const entry = String(appManifest["renderer"] ?? "index.tsx");
      const entryPath = path.resolve(input.sourcePath, entry);
      const rnHostAbi =
        typeof appManifest["rnHostAbi"] === "string" ? appManifest["rnHostAbi"] : null;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-rn-provider-"));
      ownedTempDirs.add(tempDir);
      const artifacts: BuildProviderOutput["artifacts"] = [];
      try {
        const metroConfig = writeProjectedMetroConfig(input, tempDir);
        for (const platform of ["android", "ios"] as const) {
          const bundlePath = path.join(tempDir, `index.${platform}.bundle`);
          const assetsDir = path.join(tempDir, `${platform}-assets`);
          fs.mkdirSync(assetsDir, { recursive: true });
          await runReactNativeBundle(
            input,
            platform,
            entryPath,
            bundlePath,
            assetsDir,
            metroConfig
          );
          const bundleArtifactId = randomUUID();
          artifactFiles.set(bundleArtifactId, { filePath: bundlePath, tempDir });
          artifacts.push({
            path: `index.${platform}.bundle`,
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform,
            stream: { method: "buildArtifact", args: [bundleArtifactId] },
          });
          for (const assetPath of walkFiles(assetsDir)) {
            const assetArtifactId = randomUUID();
            artifactFiles.set(assetArtifactId, { filePath: assetPath, tempDir });
            artifacts.push({
              path: `assets/${platform}/${path.relative(assetsDir, assetPath).replace(/\\/g, "/")}`,
              role: "asset",
              contentType: contentTypeForPath(assetPath),
              encoding: "base64",
              platform,
              stream: { method: "buildArtifact", args: [assetArtifactId] },
            });
          }
        }
      } catch (error) {
        for (const [artifactId, artifact] of artifactFiles) {
          if (artifact.tempDir === tempDir) artifactFiles.delete(artifactId);
        }
        ownedTempDirs.delete(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw error;
      }
      tempDirRefs.set(tempDir, artifacts.length);
      return {
        artifacts,
        metadata: {
          rnHostAbi,
        },
      };
    },
    buildArtifact(artifactId: string): ReadableStream<Uint8Array> {
      const artifact = artifactFiles.get(artifactId);
      if (!artifact) {
        throw new Error("Unknown React Native build artifact");
      }
      artifactFiles.delete(artifactId);
      const source = fs.createReadStream(artifact.filePath);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          source.on("data", (chunk) => {
            controller.enqueue(
              typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk)
            );
          });
          source.on("error", (error) => controller.error(error));
          source.on("end", () => {
            controller.close();
            releaseTempDir(artifact.tempDir, tempDirRefs);
          });
        },
        cancel() {
          source.destroy();
          releaseTempDir(artifact.tempDir, tempDirRefs);
        },
      });
    },
  };
}

async function runReactNativeBundle(
  input: BuildProviderInput,
  platform: "android" | "ios",
  entryPath: string,
  bundlePath: string,
  assetsDir: string,
  metroConfig: string
): Promise<void> {
  const nodeModulesPath = input.dependencyProjection.nodeModulesPath;
  if (!nodeModulesPath) {
    throw new Error("React Native builds require a Build V2 dependency projection");
  }
  const reactNativePath = path.join(nodeModulesPath, "react-native");
  const bundleScript = path.join(reactNativePath, "scripts", "bundle.js");
  if (!fs.existsSync(bundleScript)) {
    throw new Error(
      "Build V2 dependency projection does not contain react-native/scripts/bundle.js"
    );
  }
  const cliConfig = JSON.stringify({
    root: input.sourcePath,
    reactNativePath,
    platforms: { android: {}, ios: {} },
    dependencies: {},
    project: { android: {}, ios: {} },
    commands: [],
    assets: [],
  });
  const args = [
    bundleScript,
    "--platform",
    platform,
    "--dev",
    "false",
    "--entry-file",
    entryPath,
    "--bundle-output",
    bundlePath,
    "--assets-dest",
    assetsDir,
    "--config",
    metroConfig,
    "--max-workers",
    process.env["VIBESTUDIO_RN_BUNDLE_WORKERS"] ?? "2",
    "--load-config",
    cliConfig,
  ];
  await run(process.execPath, args, {
    cwd: input.sourcePath,
    env: {
      ...process.env,
      // Provider builds are one-shot bundles. Keep Metro out of watch mode so
      // local mobile smoke tests do not depend on the host inotify limit.
      CI: "1",
    },
  });
}

function run(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr.trim()}`)
        );
    });
  });
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function releaseTempDir(tempDir: string, refs: Map<string, number>): void {
  const remaining = (refs.get(tempDir) ?? 1) - 1;
  if (remaining > 0) {
    refs.set(tempDir, remaining);
    return;
  }
  refs.delete(tempDir);
  ownedTempDirs.delete(tempDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

export async function deactivate(): Promise<void> {
  for (const tempDir of ownedTempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  ownedTempDirs.clear();
}
