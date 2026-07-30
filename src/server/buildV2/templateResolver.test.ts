/**
 * Unit tests for template/framework resolution (`resolveTemplate`).
 *
 * Builds a throwaway source tree under os.tmpdir() with `templates/{default,
 * svelte,vanilla}` fixtures, then walks the documented resolution chain:
 *
 *   HTML:       panel index.html → named template → default template → null
 *   Framework:  template config → dep auto-detection → "vanilla"
 *
 * Self-contained: pure fs only, no esbuild / build store, so it runs under
 * plain `npx vitest`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveTemplate } from "./templateResolver.js";

let sourceRoot: string;

function writeTemplate(name: string, framework: string | null): void {
  const dir = path.join(sourceRoot, "templates", name);
  fs.mkdirSync(dir, { recursive: true });
  // template.json carries the framework (omit the field entirely when null so
  // we can exercise the "config has no framework → fall through to deps" path).
  fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify(framework ? { framework } : {}));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><head><title>${name}</title></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`
  );
}

/** Create a panel dir, optionally with its own index.html. Returns its path. */
function makePanel(name: string, ownHtml: boolean): string {
  const dir = path.join(sourceRoot, "panels", name);
  fs.mkdirSync(dir, { recursive: true });
  if (ownHtml) {
    fs.writeFileSync(
      path.join(dir, "index.html"),
      '<!doctype html><html><body><div id="app"></div></body></html>'
    );
  }
  return dir;
}

beforeEach(() => {
  sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-resolver-"));
  // Standard fixture: default ⇒ react, svelte ⇒ svelte, vanilla ⇒ vanilla.
  writeTemplate("default", "react");
  writeTemplate("svelte", "svelte");
  writeTemplate("vanilla", "vanilla");
});

afterEach(() => {
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

describe("resolveTemplate — panel with its OWN index.html (self-contained)", () => {
  it("keeps its own html and takes the framework from an explicit template field", () => {
    const panel = makePanel("own-svelte", true);
    const resolved = resolveTemplate({ template: "svelte" }, {}, panel, sourceRoot);

    // The panel's own html wins — the named template only supplies the framework.
    expect(resolved.htmlPath).toBe(path.join(panel, "index.html"));
    expect(resolved.framework).toBe("svelte");
  });

  it("falls back to dep auto-detection when no template field is set", () => {
    const panel = makePanel("own-react", true);
    const resolved = resolveTemplate({}, { "@workspace/react": "workspace:*" }, panel, sourceRoot);

    expect(resolved.htmlPath).toBe(path.join(panel, "index.html"));
    // No template field ⇒ the default template's framework must NOT bleed in;
    // the framework comes from the panel's own deps.
    expect(resolved.framework).toBe("react");
  });
});

describe("resolveTemplate — explicit template reference (no own html)", () => {
  it("uses the named template's html and framework", () => {
    const panel = makePanel("uses-svelte", false);
    const resolved = resolveTemplate({ template: "svelte" }, {}, panel, sourceRoot);

    expect(resolved.htmlPath).toBe(path.join(sourceRoot, "templates", "svelte", "index.html"));
    expect(resolved.framework).toBe("svelte");
  });
});

describe("resolveTemplate — implicit default template", () => {
  it("uses the default template's html + framework (react) when nothing else applies", () => {
    const panel = makePanel("plain", false);
    const resolved = resolveTemplate({}, {}, panel, sourceRoot);

    expect(resolved.htmlPath).toBe(path.join(sourceRoot, "templates", "default", "index.html"));
    expect(resolved.framework).toBe("react");
  });
});

describe("resolveTemplate — dependency auto-detection", () => {
  // Exercised via the self-contained (own-html, no template field) branch so the
  // framework is decided purely by deps.
  it("detects react from @workspace/react", () => {
    const panel = makePanel("dep-react", true);
    const resolved = resolveTemplate({}, { "@workspace/react": "workspace:*" }, panel, sourceRoot);
    expect(resolved.framework).toBe("react");
  });

  it("detects svelte from @workspace/svelte", () => {
    const panel = makePanel("dep-svelte", true);
    const resolved = resolveTemplate({}, { "@workspace/svelte": "workspace:*" }, panel, sourceRoot);
    expect(resolved.framework).toBe("svelte");
  });

  it("defaults to vanilla when neither framework dep is present", () => {
    const panel = makePanel("dep-none", true);
    const resolved = resolveTemplate(
      {},
      { "@workspace/runtime": "workspace:*" },
      panel,
      sourceRoot
    );
    expect(resolved.framework).toBe("vanilla");
  });
});

describe("resolveTemplate — no templates directory at all", () => {
  it("returns null html + vanilla framework", () => {
    // A source root with NO templates/ dir and a panel without its own html.
    const emptyRoot = path.join(sourceRoot, "empty-root");
    const panel = path.join(emptyRoot, "panels", "bare");
    fs.mkdirSync(panel, { recursive: true });

    const resolved = resolveTemplate({}, {}, panel, emptyRoot);

    expect(resolved).toEqual({ htmlPath: null, framework: "vanilla" });
  });
});
