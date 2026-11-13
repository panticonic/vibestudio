import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { headlessHostRpc, resolveRemoteHeadlessHostEntryPath } from "./remoteHeadlessHost.js";

describe("resolveRemoteHeadlessHostEntryPath", () => {
  it("uses the one canonical bundled entry beneath the application root", () => {
    expect(resolveRemoteHeadlessHostEntryPath({ VIBESTUDIO_APP_ROOT: "/opt/vibestudio" })).toBe(
      path.join("/opt/vibestudio", "dist", "headless-host", "index.js")
    );
  });

  it("allows an explicit entry override without introducing fallback candidates", () => {
    expect(
      resolveRemoteHeadlessHostEntryPath({
        VIBESTUDIO_APP_ROOT: "/ignored",
        VIBESTUDIO_HEADLESS_HOST_ENTRY: "./fixtures/headless-entry.mjs",
      })
    ).toBe(path.resolve("./fixtures/headless-entry.mjs"));
  });
});

describe("headlessHostRpc", () => {
  it("calls, streams and reads streams by the wire name of the receiver method descriptors the host's clients pass", async () => {
    const seen: unknown[][] = [];
    const record =
      (kind: string) =>
      async (...args: unknown[]) => {
        seen.push([kind, ...args]);
        return kind as never;
      };
    const rpc = headlessHostRpc({
      callTarget: record("call"),
      stream: record("stream"),
      streamReadable: record("streamReadable"),
    } as never);
    const method = { name: "workspace.getInfo" } as never;
    expect(await rpc.call("main", method, ["a"])).toBe("call");
    expect(await rpc.stream("main", method, [])).toBe("stream");
    expect(await rpc.streamReadable("main", "workspace.getInfo", ["b"])).toBe("streamReadable");
    expect(seen).toEqual([
      ["call", "main", "workspace.getInfo", ["a"]],
      ["stream", "main", "workspace.getInfo", [], undefined],
      ["streamReadable", "main", "workspace.getInfo", ["b"], undefined],
    ]);
  });
});
