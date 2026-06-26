/**
 * Unit tests for the framework adapter registry and the per-framework
 * compilation contracts (React / Svelte / Vanilla).
 *
 * These are fully self-contained: they exercise pure adapter metadata and the
 * `generateEntry` string generators with no filesystem, esbuild, or build-store
 * involvement, so they run under plain `npx vitest` (no better-sqlite3 / no
 * electron-rebuild needed).
 */

import { describe, expect, it } from "vitest";

import { getAdapter } from "./adapters/index.js";

describe("getAdapter", () => {
  it("returns the matching adapter for each known framework id", () => {
    expect(getAdapter("react").id).toBe("react");
    expect(getAdapter("svelte").id).toBe("svelte");
    expect(getAdapter("vanilla").id).toBe("vanilla");
  });

  it("throws for an unknown framework id", () => {
    expect(() => getAdapter("vue")).toThrow(/Unknown framework adapter/);
    // The error lists the available adapters to aid debugging.
    expect(() => getAdapter("vue")).toThrow(/react/);
    expect(() => getAdapter("")).toThrow(/Unknown framework adapter/);
  });
});

describe("reactAdapter", () => {
  const adapter = getAdapter("react");

  it("declares the react id and automatic JSX transform", () => {
    expect(adapter.id).toBe("react");
    expect(adapter.jsx).toBe("automatic");
    expect(adapter.tsconfigJsx).toBe("react-jsx");
  });

  it("dedupes react + react-dom across chunks", () => {
    expect(adapter.dedupePackages).toContain("react");
    expect(adapter.dedupePackages).toContain("react-dom");
  });

  it("generates an entry that mounts via autoMountReactPanel and imports radix styles", () => {
    const entry = adapter.generateEntry("expose", "entry");
    // References the React auto-mount helper from @workspace/react.
    expect(entry).toContain("autoMountReactPanel");
    expect(entry).toContain("@workspace/react");
    // Imports the radix design-system stylesheet so panels render without a CDN.
    expect(entry).toContain("@radix-ui/themes/styles.css");
    // Imports both the expose side-effect file and the user entry module.
    expect(entry).toContain('"expose"');
    expect(entry).toContain('"entry"');
  });
});

describe("svelteAdapter", () => {
  const adapter = getAdapter("svelte");

  it("declares the svelte id and no JSX transform", () => {
    expect(adapter.id).toBe("svelte");
    expect(adapter.jsx).toBeUndefined();
    expect(adapter.tsconfigJsx).toBeUndefined();
  });

  it("dedupes the svelte runtime across chunks", () => {
    expect(adapter.dedupePackages).toContain("svelte");
  });

  it("contributes at least one esbuild plugin (the svelte compiler)", () => {
    expect(adapter.plugins).toBeDefined();
    const plugins = adapter.plugins?.() ?? [];
    expect(plugins.length).toBeGreaterThan(0);
    // Plugins must be valid esbuild plugins (named with a setup function).
    for (const plugin of plugins) {
      expect(typeof plugin.name).toBe("string");
      expect(typeof plugin.setup).toBe("function");
    }
  });

  it("generates an entry that mounts via autoMountSveltePanel", () => {
    const entry = adapter.generateEntry("expose", "entry");
    expect(entry).toContain("autoMountSveltePanel");
    expect(entry).toContain("@workspace/svelte");
    expect(entry).toContain('"expose"');
    expect(entry).toContain('"entry"');
    // No React/radix bleed-through.
    expect(entry).not.toContain("autoMountReactPanel");
    expect(entry).not.toContain("@radix-ui/themes/styles.css");
  });
});

describe("vanillaAdapter", () => {
  const adapter = getAdapter("vanilla");

  it("declares the vanilla id and no JSX transform", () => {
    expect(adapter.id).toBe("vanilla");
    expect(adapter.jsx).toBeUndefined();
    expect(adapter.tsconfigJsx).toBeUndefined();
  });

  it("has an empty dedupe set (no framework runtime to share)", () => {
    expect(adapter.dedupePackages).toEqual([]);
  });

  it("declares no framework plugins", () => {
    // Vanilla needs no compiler plugin; `plugins` is omitted entirely.
    expect(adapter.plugins).toBeUndefined();
  });

  it("generates an entry that only imports the expose + user entry, with no mount helper", () => {
    const entry = adapter.generateEntry("expose", "entry");
    expect(entry).toContain('"expose"');
    expect(entry).toContain('"entry"');
    // Vanilla panels mount themselves — the adapter injects no framework helper.
    expect(entry).not.toMatch(/autoMount/i);
    expect(entry).not.toContain("shouldAutoMount");
    expect(entry).not.toContain("@workspace/react");
    expect(entry).not.toContain("@workspace/svelte");
  });
});
