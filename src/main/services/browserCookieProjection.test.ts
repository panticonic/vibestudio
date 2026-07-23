import { describe, expect, it, vi } from "vitest";
import type { BrowserCookieInput, StoredCookie } from "@vibestudio/browser-data";

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
}));

import {
  cookieContentHash,
  effectiveCookieContentHash,
  toElectronCookie,
} from "./browserCookieProjection.js";

function input(partial: Partial<BrowserCookieInput> = {}): BrowserCookieInput {
  return {
    name: "sid",
    value: "secret",
    domain: "example.test",
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    sourceScheme: "secure",
    sourcePort: 443,
    ...partial,
  };
}

function stored(partial: Partial<StoredCookie> = {}): StoredCookie {
  const cookie = input(partial);
  return {
    ...cookie,
    encryptedValue: "ciphertext",
    revision: 3,
    contentHash: cookieContentHash(cookie),
    createdAt: 1,
    ...partial,
  };
}

describe("canonical browser cookie projection", () => {
  it("hashes canonical content deterministically and notices material changes", () => {
    expect(cookieContentHash(input())).toBe(cookieContentHash(input()));
    expect(cookieContentHash(input({ value: "other" }))).not.toBe(cookieContentHash(input()));
    expect(cookieContentHash(input({ domain: "EXAMPLE.TEST" }))).toBe(cookieContentHash(input()));
  });

  it("preserves host-only cookies by omitting Electron's domain field", () => {
    expect(toElectronCookie(stored({ hostOnly: true }))).not.toHaveProperty("domain");
  });

  it("sets Electron's domain field for domain cookies", () => {
    expect(toElectronCookie(stored({ hostOnly: false, domain: ".example.test" }))).toMatchObject({
      domain: ".example.test",
    });
  });

  it("preserves add-then-delete ordering before the outbox flushes", () => {
    const cookie = input();
    const key = { name: cookie.name, domain: cookie.domain, path: cookie.path };
    const put = { op: "put" as const, cookie, mutationId: "put-1" };
    expect(effectiveCookieContentHash(undefined, [put], key)).toBe(cookieContentHash(cookie));

    const remove = { op: "delete" as const, key, mutationId: "delete-1" };
    expect(effectiveCookieContentHash(undefined, [put, remove], key)).toBeNull();
  });
});
