import { describe, expect, it, vi } from "vitest";
import type { RpcCaller } from "@natstack/rpc";
import { createExtensionsClient } from "./extensions.js";

describe("createExtensionsClient", () => {
  it("routes ordinary extension proxy methods through unary invoke", async () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use<{ open(args: { cwd: string }): Promise<string> }>(
      "@workspace-extensions/shell"
    );

    await shell.open({ cwd: "/repo" });

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/shell",
      "open",
      [{ cwd: "/repo" }],
    ]);
    expect(rpc.streamCall).not.toHaveBeenCalled();
  });

  it("routes declared streaming proxy methods through invokeStream", async () => {
    const response = new Response("stream");
    const rpc = createRpc(response);
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use<{
      attach(sessionId: string, opts?: { after?: number }): Promise<Response>;
      write(sessionId: string, data: string): Promise<void>;
    }>("@workspace-extensions/shell", { streamingMethods: ["attach"] });

    await expect(shell.attach("session-1", { after: 42 })).resolves.toBe(response);
    await shell.write("session-1", "x");

    expect(rpc.streamCall).toHaveBeenCalledWith("main", "extensions.invokeStream", [
      "@workspace-extensions/shell",
      "attach",
      ["session-1", { after: 42 }],
    ]);
    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/shell",
      "write",
      ["session-1", "x"],
    ]);
  });

  it("keeps Promise assimilation and inspection keys inert on extension proxies", () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.useWithStreams<Record<string, unknown>>(
      "@workspace-extensions/shell",
      ["attach"]
    );

    expect(shell["then"]).toBeUndefined();
    expect(shell["toJSON"]).toBeUndefined();
    expect(rpc.call).not.toHaveBeenCalled();
    expect(rpc.streamCall).not.toHaveBeenCalled();
  });

  it("keeps useWithStreams as an alias for the streaming use option", async () => {
    const response = new Response("stream");
    const rpc = createRpc(response);
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.useWithStreams<{
      attach(sessionId: string): Promise<Response>;
    }>("@workspace-extensions/shell", ["attach"]);

    await expect(shell.attach("session-1")).resolves.toBe(response);

    expect(rpc.streamCall).toHaveBeenCalledWith("main", "extensions.invokeStream", [
      "@workspace-extensions/shell",
      "attach",
      ["session-1"],
    ]);
  });
});

function createRpc(response: Response = new Response()): RpcCaller & {
  call: ReturnType<typeof vi.fn>;
  streamCall: ReturnType<typeof vi.fn>;
} {
  return {
    call: vi.fn(async () => undefined),
    streamCall: vi.fn(async () => response),
    emit: vi.fn(async () => undefined),
    onEvent: vi.fn(),
    exposeMethod: vi.fn(),
    exposeStreamingMethod: vi.fn(),
  } as unknown as RpcCaller & {
    call: ReturnType<typeof vi.fn>;
    streamCall: ReturnType<typeof vi.fn>;
  };
}
