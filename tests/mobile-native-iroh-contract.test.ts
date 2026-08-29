import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IROH_CONCURRENT_BI_STREAM_WINDOW } from "../packages/iroh-transport/src/nodeEndpoint.js";

const android = readFileSync(
  new URL(
    "../apps/mobile/android/app/src/main/java/app/vibestudio/mobile/VibestudioIrohModule.kt",
    import.meta.url
  ),
  "utf8"
);
const ios = readFileSync(
  new URL("../apps/mobile/ios/Vibestudio/VibestudioIroh.swift", import.meta.url),
  "utf8"
);

describe("native mobile Iroh transport contract", () => {
  it("keeps the replenishing QUIC stream window aligned across Node, Android, and iOS", () => {
    expect(IROH_CONCURRENT_BI_STREAM_WINDOW).toBe(32_768n);
    expect(android).toContain("setMaxConcurrentBiStreams(32_768u)");
    expect(ios).toContain("setMaxConcurrentBiStreams(count: 32_768)");
    expect(android).toContain("setMaxConcurrentUniStreams(0u)");
    expect(ios).toContain("setMaxConcurrentUniStreams(count: 0)");
  });

  it.each([
    ["Android", android],
    ["iOS", ios],
  ])(
    "retains one physical connection with independent bidirectional streams on %s",
    (_name, source) => {
      expect(source).toContain("openBi");
      expect(source).toContain("acceptBi");
      expect(source).toContain("connectionClosed");
      expect(source).toContain("removeStreams");
    }
  );
});
