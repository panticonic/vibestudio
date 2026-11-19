import type { RpcCaller } from "@vibestudio/rpc";
import { describe, expect, it, vi } from "vitest";
import { mainRpcMethods } from "../mainRpc.js";
import { createChromiumFetch } from "./chromiumFetchClient.js";

const url = "https://example.com/";
const responseId = "e3e3737d-a80d-4b70-b14e-0540a5fe2ba3";

function transport(headers: Record<string, string>) {
  const call = vi.fn(async (_target: string, method: unknown) => {
    if (method === mainRpcMethods["chromiumFetch.openPublic"]) {
      return { responseId, url, status: 200, statusText: "OK", headers, size: 5 };
    }
    if (method === mainRpcMethods["chromiumFetch.read"]) {
      return { bytesBase64: "aGVsbG8=", done: true };
    }
    if (method === mainRpcMethods["chromiumFetch.close"]) return;
    throw new Error("Unexpected Chromium transport method");
  });
  return {
    call,
    fetch: createChromiumFetch({ call: call as RpcCaller["call"] }, "public"),
  };
}

describe("Chromium fetch response headers", () => {
  it("reconstructs distinct CDP header fields before streaming the body", async () => {
    const { fetch } = transport({
      "content-type": "text/plain",
      "cache-control": "private\nno-cache",
      "set-cookie": "first=1; Path=/\nsecond=2; Path=/",
    });
    const response = await fetch(url);

    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);
    await expect(response.text()).resolves.toBe("hello");
  });

  it("closes the opened response when invalid metadata prevents consumption", async () => {
    const { call, fetch } = transport({ "invalid header": "value" });

    await expect(fetch(url)).rejects.toThrow(TypeError);
    expect(call).toHaveBeenCalledWith("main", mainRpcMethods["chromiumFetch.close"], [responseId]);
    expect(call).not.toHaveBeenCalledWith(
      "main",
      mainRpcMethods["chromiumFetch.read"],
      expect.anything()
    );
  });
});
