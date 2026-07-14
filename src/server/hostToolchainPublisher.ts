import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import {
  domainHash,
  parseSha256,
  sha256,
  type Sha256,
} from "@vibestudio/shared/execution/identity";
import { prependPathOnce } from "@vibestudio/shared/nativeProcessEnvironment";

export interface HostToolchainManifest {
  version: 1;
  hostBuildId: Sha256;
  vibestudioVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  runtime: { relativePath: string; digest: Sha256; version: string; nodeMode: boolean };
  cli: { relativePath: string; digest: Sha256 };
  launcher: { relativePath: string; digest: Sha256 };
  packageManager: {
    relativePath: string;
    packageRoot: string;
    entry: string;
    digest: Sha256;
    version: string;
  };
  plugin: { relativePath: string; digest: Sha256 };
  manifestDigest: Sha256;
  createdAt: number;
}

export interface PublishHostToolchainInput {
  hostBuildId: Sha256;
  vibestudioVersion: string;
  runtimePath: string;
  runtimeVersion: string;
  runtimeNodeMode?: boolean;
  cliPath: string;
  packageManagerRoot: string;
  packageManagerEntry: string;
  packageManagerVersion: string;
  pluginRoot: string;
  createdAt?: number;
}

export class HostToolchainPublisher {
  private readonly root: string;

  constructor(statePath: string) {
    this.root = path.join(path.resolve(statePath), "toolchains");
  }

  publish(input: PublishHostToolchainInput): HostToolchainManifest {
    parseSha256(input.hostBuildId, "host build id");
    const finalDir = path.join(this.root, input.hostBuildId);
    if (fs.existsSync(finalDir)) {
      const existing = this.readManifest(finalDir);
      this.verify(finalDir, existing);
      this.activate(existing.hostBuildId);
      return existing;
    }
    const tempDir = `${finalDir}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    fs.mkdirSync(path.join(tempDir, "bin"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(tempDir, "cli"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(tempDir, "runtime"), { recursive: true, mode: 0o700 });
    try {
      const runtimeName = process.platform === "win32" ? "node.exe" : "node";
      const launcherName = process.platform === "win32" ? "vibestudio.cmd" : "vibestudio";
      const packageManagerName = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      const runtimeRelative = `runtime/${runtimeName}`;
      const cliRelative = "cli/client.mjs";
      const launcherRelative = `bin/${launcherName}`;
      const packageManagerRelative = `bin/${packageManagerName}`;
      const packageRootRelative = "tools/pnpm";
      const pluginRelative = "plugins/vibestudio";
      const packageEntryRelative = canonicalRelativePath(input.packageManagerEntry);
      fs.copyFileSync(input.runtimePath, path.join(tempDir, runtimeRelative));
      fs.chmodSync(path.join(tempDir, runtimeRelative), 0o755);
      fs.copyFileSync(input.cliPath, path.join(tempDir, cliRelative));
      fs.chmodSync(path.join(tempDir, cliRelative), 0o644);
      const launcher = launcherSource(
        process.platform,
        runtimeName,
        input.runtimeNodeMode === true
      );
      fs.writeFileSync(path.join(tempDir, launcherRelative), launcher, { mode: 0o755 });
      fs.chmodSync(path.join(tempDir, launcherRelative), 0o755);
      fs.cpSync(input.packageManagerRoot, path.join(tempDir, packageRootRelative), {
        recursive: true,
        dereference: true,
        force: false,
        errorOnExist: true,
      });
      fs.cpSync(input.pluginRoot, path.join(tempDir, pluginRelative), {
        recursive: true,
        dereference: true,
        force: false,
        errorOnExist: true,
      });
      const packageManagerLauncher = packageManagerLauncherSource(
        process.platform,
        runtimeName,
        packageEntryRelative,
        input.runtimeNodeMode === true
      );
      fs.writeFileSync(path.join(tempDir, packageManagerRelative), packageManagerLauncher, {
        mode: 0o755,
      });
      fs.chmodSync(path.join(tempDir, packageManagerRelative), 0o755);

      const unsigned = {
        version: 1 as const,
        hostBuildId: input.hostBuildId,
        vibestudioVersion: input.vibestudioVersion,
        platform: process.platform,
        architecture: process.arch,
        runtime: {
          relativePath: runtimeRelative,
          digest: digestFile(path.join(tempDir, runtimeRelative)),
          version: input.runtimeVersion,
          nodeMode: input.runtimeNodeMode === true,
        },
        cli: { relativePath: cliRelative, digest: digestFile(path.join(tempDir, cliRelative)) },
        launcher: {
          relativePath: launcherRelative,
          digest: digestFile(path.join(tempDir, launcherRelative)),
        },
        packageManager: {
          relativePath: packageManagerRelative,
          packageRoot: packageRootRelative,
          entry: packageEntryRelative,
          digest: digestDirectory(path.join(tempDir, packageRootRelative)),
          version: input.packageManagerVersion,
        },
        plugin: {
          relativePath: pluginRelative,
          digest: digestDirectory(path.join(tempDir, pluginRelative)),
        },
        createdAt: input.createdAt ?? Date.now(),
      };
      const manifest: HostToolchainManifest = {
        ...unsigned,
        manifestDigest: domainHash(
          "vibestudio/host-toolchain-manifest/v1",
          canonicalJson(unsigned)
        ),
      };
      fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify(manifest, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(tempDir, finalDir);
      this.verify(finalDir, manifest);
      this.activate(input.hostBuildId);
      return manifest;
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  active(): { dir: string; manifest: HostToolchainManifest } | null {
    const pointer = path.join(this.root, "active.json");
    if (!fs.existsSync(pointer)) return null;
    const value = JSON.parse(fs.readFileSync(pointer, "utf8")) as { hostBuildId?: unknown };
    if (typeof value.hostBuildId !== "string") throw new Error("Invalid active toolchain pointer");
    const dir = path.join(this.root, value.hostBuildId);
    const manifest = this.readManifest(dir);
    this.verify(dir, manifest);
    return { dir, manifest };
  }

  extensionEnvironment(ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const active = this.active();
    if (!active) throw new Error("No active Vibestudio host toolchain");
    return {
      ...ambient,
      PATH: prependPathOnce(ambient["PATH"] ?? ambient["Path"] ?? "", path.join(active.dir, "bin")),
      VIBESTUDIO_TOOLCHAIN_DIR: active.dir,
      VIBESTUDIO_HOST_BUILD_ID: active.manifest.hostBuildId,
      VIBESTUDIO_PNPM_PATH: path.join(active.dir, active.manifest.packageManager.relativePath),
      ...(active.manifest.runtime.nodeMode ? { VIBESTUDIO_TOOLCHAIN_RUNTIME_NODE_MODE: "1" } : {}),
    };
  }

  private activate(hostBuildId: Sha256): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, "active.json");
    const temp = `${target}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, hostBuildId }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  private readManifest(dir: string): HostToolchainManifest {
    return JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf8")
    ) as HostToolchainManifest;
  }

  private verify(dir: string, manifest: HostToolchainManifest): void {
    const { manifestDigest, ...unsigned } = manifest;
    if (
      domainHash("vibestudio/host-toolchain-manifest/v1", canonicalJson(unsigned)) !==
      manifestDigest
    ) {
      throw new Error(`Toolchain manifest digest mismatch: ${dir}`);
    }
    for (const entry of [manifest.runtime, manifest.cli, manifest.launcher]) {
      if (digestFile(path.join(dir, entry.relativePath)) !== entry.digest) {
        throw new Error(`Toolchain artifact digest mismatch: ${entry.relativePath}`);
      }
    }
    if (
      digestDirectory(path.join(dir, manifest.packageManager.packageRoot)) !==
      manifest.packageManager.digest
    ) {
      throw new Error(
        `Toolchain package-manager digest mismatch: ${manifest.packageManager.packageRoot}`
      );
    }
    if (
      !fs.existsSync(
        path.join(dir, manifest.packageManager.packageRoot, manifest.packageManager.entry)
      )
    ) {
      throw new Error(
        `Toolchain package-manager entry is missing: ${manifest.packageManager.entry}`
      );
    }
    if (digestDirectory(path.join(dir, manifest.plugin.relativePath)) !== manifest.plugin.digest) {
      throw new Error(`Toolchain plugin digest mismatch: ${manifest.plugin.relativePath}`);
    }
  }
}

function packageManagerLauncherSource(
  platform: NodeJS.Platform,
  runtimeName: string,
  entry: string,
  nodeMode: boolean
): string {
  const nativeEntry = entry.split("/").join(platform === "win32" ? "\\" : "/");
  if (platform === "win32") {
    return `@echo off\r\n${nodeMode ? "set ELECTRON_RUN_AS_NODE=1\r\n" : ""}"%~dp0..\\runtime\\${runtimeName}" "%~dp0..\\tools\\pnpm\\${nativeEntry}" %*\r\n`;
  }
  return `#!/bin/sh\nset -eu\n${nodeMode ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}BIN=${"${0%/*}"}\nROOT="$(CDPATH= cd -- "$BIN/.." && pwd)"\nexec "$ROOT/runtime/${runtimeName}" "$ROOT/tools/pnpm/${nativeEntry}" "$@"\n`;
}

function canonicalRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid package-manager entry: ${value}`);
  }
  return normalized;
}

function digestDirectory(root: string): Sha256 {
  const hash = createHash("sha256");
  hash.update("vibestudio/toolchain-directory/v1\0");
  const visit = (directory: string, prefix: string): void => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const mode = fs.statSync(absolute).mode & 0o111 ? "x" : "f";
        hash.update(`${mode}\0${relative}\0`);
        hash.update(fs.readFileSync(absolute));
        hash.update("\0");
      } else {
        throw new Error(`Unsupported toolchain entry: ${relative}`);
      }
    }
  };
  visit(root, "");
  return hash.digest("hex") as Sha256;
}

function launcherSource(platform: NodeJS.Platform, runtimeName: string, nodeMode: boolean): string {
  if (platform === "win32") {
    return `@echo off\r\n${nodeMode ? "set ELECTRON_RUN_AS_NODE=1\r\n" : ""}"%~dp0..\\runtime\\${runtimeName}" "%~dp0..\\cli\\client.mjs" %*\r\n`;
  }
  return `#!/bin/sh\nset -eu\n${nodeMode ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}BIN=${"${0%/*}"}\nROOT="$(CDPATH= cd -- "$BIN/.." && pwd)"\nexec "$ROOT/runtime/${runtimeName}" "$ROOT/cli/client.mjs" "$@"\n`;
}

function digestFile(file: string): Sha256 {
  return sha256(fs.readFileSync(file));
}
