import { afterEach, describe, expect, it, vi } from "vitest";
import { TextDecoder as StandardTextDecoder } from "@kayahr/text-encoding/no-encodings";

const GoldenDecoder = globalThis.TextDecoder;
afterEach(() => vi.unstubAllGlobals());

describe("mobile standard UTF-8 decoder", () => {
  it("installs the dependency implementation when Hermes has no decoder", async () => {
    vi.stubGlobal("TextDecoder", undefined);
    vi.resetModules();
    await import("./polyfills.js");
    expect(globalThis.TextDecoder).toBe(StandardTextDecoder);
  });

  it.each([false, true])("preserves every multibyte/BOM split with fatal=%s", (fatal) => {
    const bytes = new TextEncoder().encode("\ufeffcafé € 😀 漢字");
    for (let split = 0; split <= bytes.length; split++) {
      const actual = new StandardTextDecoder("utf-8", { fatal });
      const expected = new GoldenDecoder("utf-8", { fatal });
      expect(actual.decode(bytes.subarray(0, split), { stream: true })).toBe(
        expected.decode(bytes.subarray(0, split), { stream: true })
      );
      expect(actual.decode(bytes.subarray(split))).toBe(expected.decode(bytes.subarray(split)));
    }
  });

  it.each([false, true])(
    "matches BOM handling and decoder reuse with ignoreBOM=%s",
    (ignoreBOM) => {
      const actual = new StandardTextDecoder("utf-8", { ignoreBOM });
      const expected = new GoldenDecoder("utf-8", { ignoreBOM });
      for (const value of ["\ufeffone", "\ufefftwo", "a\ufeffb"]) {
        const bytes = new TextEncoder().encode(value);
        expect(actual.decode(bytes)).toBe(expected.decode(bytes));
      }
    }
  );

  it.each([
    [0xc0, 0xaf],
    [0xe2, 0x28, 0xa1],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xe2, 0x82],
  ])("matches malformed UTF-8 replacement and fatal rejection for %j", (...input) => {
    const bytes = Uint8Array.from(input);
    expect(new StandardTextDecoder().decode(bytes)).toBe(new GoldenDecoder().decode(bytes));
    expect(() => new StandardTextDecoder("utf-8", { fatal: true }).decode(bytes)).toThrow(
      TypeError
    );
  });

  it("flushes truncated streamed characters and rejects them in fatal mode", () => {
    for (const Decoder of [StandardTextDecoder, GoldenDecoder]) {
      const loose = new Decoder();
      expect(loose.decode(Uint8Array.of(0xe2, 0x82), { stream: true })).toBe("");
      expect(loose.decode()).toBe("\ufffd");
      const fatal = new Decoder("utf-8", { fatal: true });
      expect(fatal.decode(Uint8Array.of(0xe2, 0x82), { stream: true })).toBe("");
      expect(() => fatal.decode()).toThrow(TypeError);
    }
  });

  it("decodes typed-array subviews without requiring a Node Buffer", () => {
    vi.stubGlobal("Buffer", undefined);
    const bytes = new TextEncoder().encode("xx😀yy");
    expect(new StandardTextDecoder().decode(new DataView(bytes.buffer, 2, 4))).toBe("😀");
  });
});
