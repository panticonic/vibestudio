import { describe, expect, it, vi } from "vitest";
import type { IrohConnection } from "./connect.js";
import { IROH_REACH_VERSION } from "@vibestudio/iroh-transport";
import { MobileWorkspaceAccount } from "./workspaceAccount.js";

const reach = (digit: string) => ({
  v: IROH_REACH_VERSION,
  endpointId: digit.repeat(64),
  relays: ["https://relay.example/"],
});
function connection() {
  return {
    rpc: { call: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as IrohConnection;
}
function route(workspaceId: string, digit: string) {
  return {
    workspace: workspaceId,
    workspaceId,
    running: true,
    serverUrl: "http://127.0.0.1:1234",
    serverId: `srv_${"a".repeat(24)}`,
    serverBootId: `boot_${"b".repeat(24)}`,
    workspaceReach: reach(digit),
  };
}

describe("mobile account workspace sessions", () => {
  it("retains one account pipe and independent workspace callers across selection", async () => {
    const control = connection();
    const a = connection();
    const b = connection();
    vi.mocked(control.rpc.call)
      .mockResolvedValueOnce(route("a", "a"))
      .mockResolvedValueOnce(route("b", "b"));
    const connect = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const account = new MobileWorkspaceAccount(control, connect);
    const first = await account.openWorkspace("a");
    const second = await account.openWorkspace("b");
    expect(first.rpc).toBe(a.rpc);
    expect(second.rpc).toBe(b.rpc);
    expect(first.hubControlRpc).toBe(control.rpc);
    expect(second.hubControlRpc).toBe(control.rpc);
    await first.close();
    await first.close();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(control.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
    await account.close();
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(control.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a route that changes the selected workspace before dialing", async () => {
    const control = connection();
    vi.mocked(control.rpc.call).mockResolvedValue(route("other", "a"));
    const connect = vi.fn();
    const account = new MobileWorkspaceAccount(control, connect);
    await expect(account.openWorkspace("selected")).rejects.toThrow("different workspace");
    expect(connect).not.toHaveBeenCalled();
    await account.close();
  });

  it("closes a child handshake that finishes after account disposal", async () => {
    const control = connection();
    const child = connection();
    vi.mocked(control.rpc.call).mockResolvedValue(route("a", "a"));
    let resolve!: (connection: IrohConnection) => void;
    const connect = vi.fn(
      () =>
        new Promise<IrohConnection>((done) => {
          resolve = done;
        })
    );
    const account = new MobileWorkspaceAccount(control, connect);
    const pending = account.openWorkspace("a");
    const rejected = expect(pending).rejects.toThrow("closed while connecting");
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    const closing = account.close();
    resolve(child);
    await rejected;
    await closing;
    expect(child.close).toHaveBeenCalledTimes(1);
    expect(control.close).toHaveBeenCalledTimes(1);
    await expect(account.openWorkspace("a")).rejects.toThrow("account is closed");
  });

  it("attempts all child and account cleanup when one child fails", async () => {
    const control = connection();
    const a = connection();
    const b = connection();
    vi.mocked(a.close).mockRejectedValue(new Error("child cleanup failed"));
    vi.mocked(control.rpc.call)
      .mockResolvedValueOnce(route("a", "a"))
      .mockResolvedValueOnce(route("b", "b"));
    const account = new MobileWorkspaceAccount(
      control,
      vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b)
    );
    await account.openWorkspace("a");
    await account.openWorkspace("b");
    await expect(account.close()).rejects.toMatchObject({
      errors: [new Error("child cleanup failed")],
    });
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(control.close).toHaveBeenCalledTimes(1);
  });
});
