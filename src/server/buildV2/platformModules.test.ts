/**
 * Tests for the platform-module contract (platformModules.ts) — the single
 * registry of workspace package names the host build system depends on.
 *
 * These lock in the contract VALUES on purpose: renaming a workspace
 * counterpart package is a breaking platform change and should fail loudly
 * here, not surface as a mysterious build/runtime failure.
 */

import { describe, expect, it } from "vitest";

import {
  RUNTIME_MODULE,
  CDP_CLIENT_MODULE,
  WORKER_RUNTIME_COMPANION_MODULES,
  TERMINAL_SHIM_MODULE,
  TERMINAL_SHIM_YOGA,
  TERMINAL_SHIM_SIGNAL_EXIT,
  TERMINAL_SHIM_TERMINAL_SIZE,
  FRAMEWORK_MODULES,
  REACT_FRAMEWORK_MODULE,
  SVELTE_FRAMEWORK_MODULE,
  frameworkEntryModule,
  detectFrameworkFromDependencies,
} from "./platformModules.js";

describe("platform module names (contract values)", () => {
  it("declares the runtime SDK and its worker companions", () => {
    expect(RUNTIME_MODULE).toBe("@workspace/runtime");
    expect(CDP_CLIENT_MODULE).toBe("@workspace/cdp-client");
    expect(WORKER_RUNTIME_COMPANION_MODULES).toEqual(["@workspace/cdp-client"]);
  });

  it("declares the terminal-shim subpaths the builder substitutes", () => {
    expect(TERMINAL_SHIM_MODULE).toBe("@workspace/terminal-shim");
    expect(TERMINAL_SHIM_YOGA).toBe("@workspace/terminal-shim/yoga");
    expect(TERMINAL_SHIM_SIGNAL_EXIT).toBe("@workspace/terminal-shim/node/signal-exit");
    expect(TERMINAL_SHIM_TERMINAL_SIZE).toBe("@workspace/terminal-shim/node/terminal-size");
  });

  it("declares the framework auto-mount modules with their mount exports", () => {
    expect(FRAMEWORK_MODULES).toEqual([
      { framework: "react", module: "@workspace/react", autoMountExport: "autoMountReactPanel" },
      {
        framework: "svelte",
        module: "@workspace/svelte",
        autoMountExport: "autoMountSveltePanel",
      },
    ]);
  });
});

describe("frameworkEntryModule", () => {
  it("maps framework ids to their default workspace modules", () => {
    expect(frameworkEntryModule("react")).toBe(REACT_FRAMEWORK_MODULE);
    expect(frameworkEntryModule("svelte")).toBe(SVELTE_FRAMEWORK_MODULE);
  });

  it("returns null for frameworks without a counterpart module", () => {
    expect(frameworkEntryModule("vanilla")).toBeNull();
    expect(frameworkEntryModule("vue")).toBeNull();
  });
});

describe("detectFrameworkFromDependencies", () => {
  it("detects a framework from its counterpart module dependency", () => {
    expect(detectFrameworkFromDependencies({ "@workspace/react": "workspace:*" })).toBe("react");
    expect(detectFrameworkFromDependencies({ "@workspace/svelte": "workspace:*" })).toBe("svelte");
  });

  it("returns null when no framework module is declared", () => {
    expect(detectFrameworkFromDependencies({})).toBeNull();
    expect(detectFrameworkFromDependencies({ "@workspace/runtime": "workspace:*" })).toBeNull();
  });

  it("prefers the first contract entry when multiple modules are declared", () => {
    expect(
      detectFrameworkFromDependencies({
        "@workspace/svelte": "workspace:*",
        "@workspace/react": "workspace:*",
      })
    ).toBe("react");
  });
});
