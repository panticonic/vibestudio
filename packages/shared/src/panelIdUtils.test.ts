/**
 * Tests for panelIdUtils: sanitizePanelIdSegment, generatePanelNonce, computePanelId.
 */

import {
  sanitizePanelIdSegment,
  panelIdSegmentFromName,
  generatePanelNonce,
  computePanelId,
  derivePanelOperationIdentity,
  type PanelOperationIdentityInput,
} from "./panelIdUtils.js";
import { createHash } from "node:crypto";

beforeEach(() => {
  vi.stubGlobal("crypto", {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.set([0xde, 0xad, 0xbe, 0xef]);
      return bytes;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("derivePanelOperationIdentity", () => {
  const vectors: Array<{ input: PanelOperationIdentityInput; hash: string }> = [
    {
      input: { operationId: "operation-1", source: "panels/chat" },
      hash: "9a89b23aa4f8888d76f1bbd3",
    },
    {
      input: {
        operationId: "réessayer😀",
        source: "panels/会話",
        contextId: "ctx:ä",
        parentId: "panel:tree/parent",
        ref: "event:abc",
      },
      hash: "65b29e78e7fdfd600957286d",
    },
  ];
  it.each(vectors)(
    "preserves UTF-8 SHA-256 identity without native WebCrypto: $hash",
    async ({ input, hash }) => {
      // The actual mobile platform supplies randomness, but not crypto.subtle.
      expect(globalThis.crypto.subtle).toBeUndefined();
      const material = [
        input.operationId,
        input.source,
        input.contextId ?? "",
        input.parentId ?? "",
        input.ref ?? "latest",
      ].join("\u0000");
      expect(createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24)).toBe(hash);
      await expect(derivePanelOperationIdentity(input)).resolves.toEqual({
        operationSegment: `op-${hash}`,
        entryKey: `nav-op-${hash}`,
      });
    }
  );

  it("preserves absent-coordinate defaults and distinguishes every explicit coordinate", async () => {
    const input = { operationId: "operation-1", source: "panels/chat" };
    const identity = await derivePanelOperationIdentity(input);
    await expect(
      derivePanelOperationIdentity({ ...input, contextId: null, parentId: "", ref: "latest" })
    ).resolves.toEqual(identity);
    const variants = [
      { operationId: "operation-2" },
      { source: "panels/other" },
      { contextId: "ctx:other" },
      { parentId: "panel:tree/other" },
      { ref: "event:other" },
      { ref: "" },
    ];
    const identities = await Promise.all(
      variants.map((variant) => derivePanelOperationIdentity({ ...input, ...variant }))
    );
    expect(new Set([identity, ...identities].map((value) => value.operationSegment)).size).toBe(
      variants.length + 1
    );
  });
});

describe("sanitizePanelIdSegment", () => {
  // --- valid inputs ---
  it("returns trimmed segment for valid input", () => {
    expect(sanitizePanelIdSegment("  my-panel  ")).toBe("my-panel");
  });

  it("allows alphanumeric-only segment", () => {
    expect(sanitizePanelIdSegment("foo")).toBe("foo");
  });

  it("allows segment with hyphens and underscores", () => {
    expect(sanitizePanelIdSegment("foo-bar_baz")).toBe("foo-bar_baz");
  });

  it("allows tilde in segment (used by system for about-panel names)", () => {
    // About-panels generate segments of the form `<page>~<timestamp36>`, e.g. "new~lk2f8g"
    expect(sanitizePanelIdSegment("new~lk2f8g")).toBe("new~lk2f8g");
  });

  // --- invalid inputs: path-traversal and shape-violation cases ---
  it("throws for empty string", () => {
    expect(() => sanitizePanelIdSegment("")).toThrow("Invalid panel identifier segment");
  });

  it("throws for dot segment (.)", () => {
    expect(() => sanitizePanelIdSegment(".")).toThrow("Invalid panel identifier segment");
  });

  it("throws for double-dot segment (..) [C3: path-traversal fix]", () => {
    // Previously allowed by the deny-list; now rejected by the allow-list.
    expect(() => sanitizePanelIdSegment("..")).toThrow("Invalid panel identifier segment");
  });

  it("throws for triple-dot segment (...)", () => {
    expect(() => sanitizePanelIdSegment("...")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment containing / (path separator)", () => {
    expect(() => sanitizePanelIdSegment("a/b")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment containing backslash", () => {
    expect(() => sanitizePanelIdSegment("a\\b")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment with leading hyphen", () => {
    expect(() => sanitizePanelIdSegment("-foo")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment with leading underscore", () => {
    expect(() => sanitizePanelIdSegment("_foo")).toThrow("Invalid panel identifier segment");
  });
});

describe("panelIdSegmentFromName", () => {
  it("preserves already-valid panel id segments", () => {
    expect(panelIdSegmentFromName("my-panel")).toBe("my-panel");
  });

  it("coerces human-readable names to safe panel id segments", () => {
    expect(panelIdSegmentFromName("StateArgs CDP Test")).toBe("StateArgs-CDP-Test");
    expect(panelIdSegmentFromName("  My Panel!!  ")).toBe("My-Panel");
    expect(panelIdSegmentFromName("a/b\\c")).toBe("a-b-c");
  });

  it("still rejects names without any usable id characters", () => {
    expect(() => panelIdSegmentFromName("...")).toThrow("Invalid panel identifier segment");
  });
});

describe("generatePanelNonce", () => {
  it("returns string in timestamp-hex format", () => {
    const nonce = generatePanelNonce();
    // With mocked randomBytes returning deadbeef, the hex portion is "deadbeef"
    expect(nonce).toMatch(/^[a-z0-9]+-deadbeef$/);
  });
});

describe("computePanelId", () => {
  it("root panels get panel:tree/{escapedPath}/{nonce}", () => {
    const id = computePanelId({ relativePath: "src/index.ts", isRoot: true });
    expect(id).toMatch(/^panel:tree\/src~index\.ts\/[a-z0-9]+-deadbeef$/);
  });

  it("named children get {parentId}/{name}", () => {
    const id = computePanelId({
      relativePath: "child.ts",
      parent: { id: "panel:tree/parent" },
      requestedId: "my-child",
    });
    expect(id).toBe("panel:tree/parent/my-child");
  });

  it("auto children get {parentId}/{escapedPath}/{nonce}", () => {
    const id = computePanelId({
      relativePath: "sub/file.ts",
      parent: { id: "panel:tree/parent" },
    });
    // nonce is mocked: timestamp-deadbeef
    expect(id).toMatch(/^panel:tree\/parent\/sub~file\.ts\/[a-z0-9]+-deadbeef$/);
  });

  it("uses 'panel:tree' as prefix when parent is null", () => {
    const id = computePanelId({
      relativePath: "file.ts",
      parent: null,
    });
    expect(id).toMatch(/^panel:tree\/file\.ts\/[a-z0-9]+-deadbeef$/);
  });

  it("named child with no parent defaults parentPrefix to 'panel:tree'", () => {
    const id = computePanelId({
      relativePath: "file.ts",
      requestedId: "named",
    });
    expect(id).toBe("panel:tree/named");
  });
});
