import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IROH_CONCURRENT_BI_STREAM_WINDOW } from "../packages/iroh-transport/src/nodeEndpoint.js";

const android = readFileSync(
  new URL(
    "../hosts/android/app/src/main/java/app/vibestudio/mobile/VibestudioIrohModule.kt",
    import.meta.url
  ),
  "utf8"
);
const ios = readFileSync(
  new URL("../hosts/ios/Vibestudio/VibestudioIroh.swift", import.meta.url),
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
      expect(source).toContain("retireStreams");
    }
  );

  it.each([
    ["Android", android],
    ["iOS", ios],
  ])("leases send and receive operations until completion on %s", (_name, source) => {
    expect(source).toContain("activeOperations");
    expect(source).toContain("acquireSend");
    expect(source).toContain("acquireReceive");
    expect(source).toContain("releaseSend");
    expect(source).toContain("releaseReceive");
    expect(source).toContain("entry.retiring && entry.activeOperations == 0");
    expect(source).toContain("claimSendTerminal");
    expect(source).toContain("claimReceiveTerminal");
    expect(source).not.toContain("requireSend(handle)");
    expect(source).not.toContain("requireReceive(handle)");
  });

  it("leases every send and receive operation through its suspended native call", () => {
    expect(android.match(/finally \{ releaseSend\(handle, entry\) \}/gu)).toHaveLength(4);
    expect(android.match(/finally \{ releaseReceive\(handle, entry\) \}/gu)).toHaveLength(4);
    expect(ios.match(/defer \{ self\.releaseSend\(handle, entry\) \}/gu)).toHaveLength(4);
    expect(ios.match(/defer \{ self\.releaseReceive\(handle, entry\) \}/gu)).toHaveLength(4);
  });

  it("gives stream terminal operations one owner and defers connection cleanup", () => {
    expect(android).toContain("if (entry.terminalClaimed) return@synchronized null");
    expect(android).toContain("private fun retireStreams(connectionHandle: String)");
    expect(android).toContain("sends.values.forEach { it.retiring = true }");
    expect(ios).toContain("if entry.terminalClaimed { return nil }");
    expect(ios).toContain("guard !entry.retiring else { throw BridgeError.closedStream");
    expect(ios).toContain("private func retireStreamsLocked(connectionHandle: String)");
    expect(ios).toContain("sends.values.forEach { $0.retiring = true }");
    expect(android.indexOf("owner.cancelAndJoin()")).toBeLessThan(android.indexOf("sends.clear()"));
    expect(android).toContain("connections.remove(handle)?.also { retireStreams(handle) }");
    expect(ios).toContain("let connection = retireConnection(handle)");
    expect(ios).toContain("entry.activeOperations -= 1");
  });
});
