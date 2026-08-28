import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditWorkspaceDependencies, compositionForKind } from "./dependencyAudit.js";
import { discoverPackageGraph } from "./packageGraph.js";

let workspaceRoot: string;
let hostNodeModules: string;

function writeUnit(relativePath: string, manifest: Record<string, unknown>): void {
  const dir = path.join(workspaceRoot, ...relativePath.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, "index.ts"), "export {};\n");
}

function writeHostPackage(packageName: string, manifest: Record<string, unknown>): void {
  const dir = path.join(hostNodeModules, ...packageName.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: packageName, ...manifest }, null, 2)
  );
}

function audit(): string[] {
  return auditWorkspaceDependencies(discoverPackageGraph(workspaceRoot), workspaceRoot, [
    hostNodeModules,
  ]).map((finding) => `${finding.unitPath}: ${finding.message}`);
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dep-audit-"));
  hostNodeModules = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-host-modules-"));
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(hostNodeModules, { recursive: true, force: true });
});

describe("compositionForKind", () => {
  it("treats packages and skills as libraries and everything buildable as a root", () => {
    // Skills are discovered as packages, so one rule covers both.
    expect(compositionForKind("package")).toBe("library");
    for (const kind of ["panel", "app", "worker", "extension"] as const) {
      expect(compositionForKind(kind)).toBe("runtime-root");
    }
    expect(compositionForKind("template")).toBeNull();
  });
});

describe("auditWorkspaceDependencies", () => {
  it("passes a workspace where every peer has an owner", () => {
    writeUnit("packages/ui", {
      name: "@workspace/ui",
      peerDependencies: { react: "19.2.4" },
    });
    writeUnit("panels/chat", {
      name: "@workspace-panels/chat",
      dependencies: { "@workspace/ui": "workspace:*", react: "19.2.4", "react-dom": "19.2.4" },
    });

    expect(audit()).toEqual([]);
  });

  it("reports a runtime root that owns nothing its closure asked for", () => {
    writeUnit("packages/ui", {
      name: "@workspace/ui",
      peerDependencies: { react: "19.2.4" },
    });
    writeUnit("panels/chat", {
      name: "@workspace-panels/chat",
      dependencies: { "@workspace/ui": "workspace:*" },
    });

    expect(audit()).toEqual([
      "panels/chat: @workspace-panels/chat is loaded on its own, so nothing provides its " +
        "closure's peers: react@19.2.4 (required by @workspace/ui). Declare each as a " +
        "dependency of @workspace-panels/chat at the version it should own.",
    ]);
  });

  it("leaves a library's peers to the realm that will load it", () => {
    writeUnit("packages/ui", {
      name: "@workspace/ui",
      peerDependencies: { react: "19.2.4" },
    });
    writeUnit("skills/onboarding", {
      name: "@workspace-skills/onboarding",
      dependencies: { "@workspace/ui": "workspace:*" },
    });

    // Both are libraries: nothing to own, nothing to report.
    expect(audit()).toEqual([]);
  });

  it("sees peers that arrive through a host package, and names the package", () => {
    // The half of an app's closure that a workspace-only walk cannot see. The
    // owner has to read as a package a manifest author recognizes, not as a
    // path into someone else's checkout.
    writeHostPackage("@vibestudio/native-camera", {
      peerDependencies: { "react-native-camera-kit": "^16.0.0" },
    });
    writeUnit("apps/mobile", {
      name: "@workspace-apps/mobile",
      dependencies: { "@vibestudio/native-camera": "workspace:*" },
    });

    expect(audit()).toEqual([
      "apps/mobile: @workspace-apps/mobile is loaded on its own, so nothing provides its " +
        "closure's peers: react-native-camera-kit@^16.0.0 (required by @vibestudio/native-camera). " +
        "Declare each as a dependency of @workspace-apps/mobile at the version it should own.",
    ]);

    // Owning it at a version the peer range admits settles it.
    writeUnit("apps/mobile", {
      name: "@workspace-apps/mobile",
      dependencies: {
        "@vibestudio/native-camera": "workspace:*",
        "react-native-camera-kit": "16.0.1",
      },
    });
    expect(audit()).toEqual([]);
  });

  it("reports a version a declaring package does not accept", () => {
    writeUnit("packages/quickfire-core", {
      name: "@workspace/quickfire-core",
      peerDependencies: { react: "19.0.0" },
    });
    writeUnit("apps/shell", {
      name: "@workspace-apps/shell",
      dependencies: { "@workspace/quickfire-core": "workspace:*", react: "19.2.4" },
    });

    expect(audit()).toEqual([
      "apps/shell: @workspace-apps/shell resolves a dependency its own closure rejects: " +
        "react resolves to 19.2.4, which @workspace/quickfire-core does not accept " +
        "(it requires 19.0.0).",
    ]);
  });

  it("does not make a root own a peer every declarer marked optional", () => {
    writeUnit("packages/eval", {
      name: "@workspace/eval",
      peerDependencies: { react: "19.2.4" },
      peerDependenciesMeta: { react: { optional: true } },
    });
    writeUnit("workers/agent", {
      name: "@workspace-workers/agent",
      dependencies: { "@workspace/eval": "workspace:*" },
    });

    expect(audit()).toEqual([]);
  });
});
