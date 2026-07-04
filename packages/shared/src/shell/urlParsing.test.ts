import { describe, it, expect } from "vitest";
import { isManagedHost, parsePanelUrl } from "./urlParsing.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isManagedHost()", () => {
  const host = "vibez1.example.com";

  it("returns true for exact host match", () => {
    expect(isManagedHost("https://vibez1.example.com/path", host)).toBe(true);
  });

  it("matches exact host regardless of port", () => {
    expect(isManagedHost("https://vibez1.example.com:8080/path", host)).toBe(true);
  });

  it("requires the port when the managed authority includes one", () => {
    expect(isManagedHost("http://127.0.0.1:5173/path", "127.0.0.1:5173")).toBe(true);
    expect(isManagedHost("http://127.0.0.1:5174/path", "127.0.0.1:5173")).toBe(false);
  });

  it("returns false for subdomains", () => {
    expect(isManagedHost("https://sub.vibez1.example.com:3000/path", host)).toBe(false);
  });

  it("returns false for completely different host", () => {
    expect(isManagedHost("https://google.com/path", host)).toBe(false);
  });

  it("returns false for partial hostname match that is not a subdomain", () => {
    expect(isManagedHost("https://evilvibez1.example.com/path", host)).toBe(false);
  });

  it("returns false for invalid URL", () => {
    expect(isManagedHost("not-a-url", host)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isManagedHost("", host)).toBe(false);
  });

  it("works with http scheme", () => {
    expect(isManagedHost("http://vibez1.example.com/", host)).toBe(true);
  });
});

describe("parsePanelUrl()", () => {
  const host = "vibez1.example.com";

  it("parses a basic panel URL with source path", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat", host);

    expect(result).not.toBeNull();
    expect(result!.source).toBe("panels/chat");
    expect(result!.contextId).toBeUndefined();
    expect(result!.options.name).toBeUndefined();
    expect(result!.options.focus).toBeUndefined();
    expect(result!.stateArgs).toBeUndefined();
  });

  it("parses URL with contextId query param", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat?contextId=ctx-123", host);

    expect(result).not.toBeNull();
    expect(result!.source).toBe("panels/chat");
    expect(result!.contextId).toBe("ctx-123");
    expect(result!.options.contextId).toBe("ctx-123");
  });

  it("parses URL with name query param", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat?name=My%20Panel", host);

    expect(result).not.toBeNull();
    expect(result!.options.name).toBe("My Panel");
  });

  it("parses URL with focus=true query param", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat?focus=true", host);

    expect(result).not.toBeNull();
    expect(result!.options.focus).toBe(true);
  });

  it("does not set focus for focus=false", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat?focus=false", host);

    expect(result).not.toBeNull();
    expect(result!.options.focus).toBeUndefined();
  });

  it("parses URL with valid stateArgs JSON", () => {
    const stateArgs = JSON.stringify({ key: "value", count: 42 });
    const result = parsePanelUrl(
      `https://vibez1.example.com/panels/chat?stateArgs=${encodeURIComponent(stateArgs)}`,
      host
    );

    expect(result).not.toBeNull();
    expect(result!.stateArgs).toEqual({ key: "value", count: 42 });
  });

  it("handles invalid stateArgs JSON gracefully", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat?stateArgs=not-json", host);

    expect(result).not.toBeNull();
    expect(result!.stateArgs).toBeUndefined();
  });

  it("returns null for non-managed host", () => {
    const result = parsePanelUrl("https://google.com/panels/chat", host);
    expect(result).toBeNull();
  });

  it("returns null for URL without two-segment path", () => {
    const result = parsePanelUrl("https://vibez1.example.com/single", host);
    expect(result).toBeNull();
  });

  it("returns null for root path", () => {
    const result = parsePanelUrl("https://vibez1.example.com/", host);
    expect(result).toBeNull();
  });

  it("returns null for URL with trailing path segments", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat/extra/segment", host);
    expect(result).toBeNull();
  });

  it("returns null when _bk param is present", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat?_bk=true", host);
    expect(result).toBeNull();
  });

  it("returns null when pid param is present", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat?pid=abc", host);
    expect(result).toBeNull();
  });

  it("returns null when _fresh param is present", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat?_fresh=1", host);
    expect(result).toBeNull();
  });

  it("returns null for invalid URL", () => {
    const result = parsePanelUrl("not-a-url", host);
    expect(result).toBeNull();
  });

  it("requires the managed authority port when parsing loopback panel URLs", () => {
    expect(parsePanelUrl("http://127.0.0.1:5173/panels/chat", "127.0.0.1:5173")).not.toBeNull();
    expect(parsePanelUrl("http://127.0.0.1:5174/panels/chat", "127.0.0.1:5173")).toBeNull();
  });

  it("returns null for subdomain URLs", () => {
    const result = parsePanelUrl("https://sub.vibez1.example.com/panels/chat", host);

    expect(result).toBeNull();
  });

  it("parses URL with multiple query params", () => {
    const result = parsePanelUrl(
      "https://vibez1.example.com/panels/chat?contextId=ctx-1&name=Test&focus=true",
      host
    );

    expect(result).not.toBeNull();
    expect(result!.contextId).toBe("ctx-1");
    expect(result!.options.name).toBe("Test");
    expect(result!.options.focus).toBe(true);
  });

  it("returns null for URL with trailing slash on a 3-segment path", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat/extra/", host);
    expect(result).toBeNull();
  });

  it("accepts URL with trailing slash on two-segment path", () => {
    const result = parsePanelUrl("https://vibez1.example.com/panels/chat/", host);

    expect(result).not.toBeNull();
    expect(result!.source).toBe("panels/chat");
  });
});
