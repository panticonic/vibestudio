import { describe, expect, it, vi } from "vitest";
import { createDurableObjectServiceClient } from "./userlandServiceRpc";

describe("createDurableObjectServiceClient", () => {
  it("retries service resolution after a transient failure", async () => {
    let fail = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = vi.fn(async (target: string, method: string, args: unknown[]): Promise<any> => {
      if (target === "main" && method === "workers.resolveService") {
        expect(args).toEqual(["vcs", null]);
        if (fail) throw new Error("resolver unavailable");
        return { kind: "durable-object", targetId: "do:vcs" };
      }
      if (target === "do:vcs" && method === "ping") return "pong";
      throw new Error(`unexpected call ${target}.${method}`);
    });
    const client = createDurableObjectServiceClient({ call }, "vcs");

    await expect(client.call("ping")).rejects.toThrow("resolver unavailable");
    fail = false;
    await expect(client.call("ping")).resolves.toBe("pong");

    const resolveCalls = call.mock.calls.filter(
      ([target, method]) => target === "main" && method === "workers.resolveService"
    );
    expect(resolveCalls).toHaveLength(2);
  });
});
