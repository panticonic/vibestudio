import { describe, it, expect } from "vitest";
import {
  vaultContextId,
  vaultPathMapping,
  normalizeVaultPath,
  shouldRebindToVaultContext,
} from "./vaultContext.js";

// Mirrors contextFolderManager's validateContextId grammar (must stay in sync).
const CONTEXT_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

describe("vaultContextId", () => {
  it("produces a valid, stable context id under 63 chars", () => {
    const id = vaultContextId("projects/default");
    expect(id).toMatch(/^vault-[a-z0-9]+$/);
    expect(id.length).toBeLessThanOrEqual(63);
    expect(CONTEXT_ID_RE.test(id)).toBe(true);
    // Stable across calls + normalization-equivalent inputs.
    expect(vaultContextId("projects/default")).toBe(id);
    expect(vaultContextId("/projects/default/")).toBe(id);
    expect(vaultContextId("projects\\default")).toBe(id);
  });

  it("distinguishes different vaults", () => {
    expect(vaultContextId("projects/a")).not.toBe(vaultContextId("projects/b"));
    expect(vaultContextId("projects/notes")).not.toBe(vaultContextId("projects/notes2"));
  });
});

describe("shouldRebindToVaultContext", () => {
  it("rebinds a selected vault unless the runtime is already on its canonical context", () => {
    expect(shouldRebindToVaultContext("projects/default", "agent-context")).toBe(true);
    const stable = vaultContextId("projects/default");
    expect(shouldRebindToVaultContext("projects/default", stable)).toBe(false);
    expect(shouldRebindToVaultContext("projects/default", undefined)).toBe(false);
  });
});

describe("vaultPathMapping", () => {
  it("maps vault-relative ↔ workspace-relative vcs paths", () => {
    const m = vaultPathMapping("projects/default");
    expect(m.root).toBe("projects/default");
    expect(m.toVcsPath("E2E.mdx")).toBe("projects/default/E2E.mdx");
    expect(m.toVcsPath("sub/Note.mdx")).toBe("projects/default/sub/Note.mdx");
    expect(m.toVaultRelPath("projects/default/E2E.mdx")).toBe("E2E.mdx");
    expect(m.toVaultRelPath("projects/default/sub/Note.mdx")).toBe("sub/Note.mdx");
  });

  it("returns null for paths outside the vault", () => {
    const m = vaultPathMapping("projects/default");
    expect(m.toVaultRelPath("projects/other/X.mdx")).toBeNull();
    expect(m.toVaultRelPath("packages/foo.ts")).toBeNull();
    expect(m.contains("projects/default/X.mdx")).toBe(true);
    expect(m.contains("projects/other/X.mdx")).toBe(false);
  });

  it("handles the tree-root vault (empty root)", () => {
    const m = vaultPathMapping("");
    expect(m.root).toBe("");
    expect(m.toVcsPath("X.mdx")).toBe("X.mdx");
    expect(m.toVaultRelPath("X.mdx")).toBe("X.mdx");
    expect(m.contains("anything.mdx")).toBe(true);
  });

  it("normalizes slashes on both directions", () => {
    const m = vaultPathMapping("/projects/default/");
    expect(m.toVcsPath("/E2E.mdx")).toBe("projects/default/E2E.mdx");
    expect(m.toVaultRelPath("/projects/default/E2E.mdx/")).toBe("E2E.mdx");
  });
});

describe("normalizeVaultPath", () => {
  it("strips leading/trailing slashes and converts backslashes", () => {
    expect(normalizeVaultPath("/a/b/")).toBe("a/b");
    expect(normalizeVaultPath("a\\b")).toBe("a/b");
    expect(normalizeVaultPath("")).toBe("");
  });
});
