import { describe, expect, it } from "vitest";
import { serializeRpcFailure } from "@vibestudio/rpc";
import { DurableObjectBase } from "./index.js";
import { createTestDO } from "./test-utils.js";
import {
  callOrRestart,
  cpuLimitForTimeout,
  createCodeHostClient,
  isHostedCall,
  serveHostedCall,
  type CodeHostProps,
} from "./codeHost.js";

const EXPOSED = Symbol.for("vibestudio.rpc.exposedMethods");

class Kernel {
  static [EXPOSED] = new Set(["add", "boom", "nothing"]);
  add(a: number, b: number): { sum: number; at: Date } {
    return { sum: a + b, at: new Date(0) };
  }
  boom(): never {
    throw new Error("kernel failure");
  }
  nothing(): void {}
  hidden(): string {
    return "not exposed";
  }
}

const hostedProps: CodeHostProps = { host: { entityId: "do:s:C:k", token: "t" } };

describe("serveHostedCall", () => {
  const call = async (method: string, args: unknown[], props = hostedProps) => {
    const response = await serveHostedCall({
      instance: new Kernel(),
      props,
      method: `__hosted/${method}`,
      body: JSON.stringify({ args }),
      onRevoked: async () => {},
    });
    return { status: response.status, body: await response.json() };
  };

  it("calls an exposed method and returns its result, null for undefined", async () => {
    expect((await call("add", [2, 3])).body.result.sum).toBe(5);
    expect(await call("nothing", [])).toMatchObject({ status: 200, body: { result: null } });
  });

  it("refuses an unexposed method and a class that is not hosted", async () => {
    expect((await call("hidden", [])).status).toBe(404);
    expect((await call("add", [1, 2], {})).status).toBe(403);
  });

  it("carries a failure to the caller as a serialized error", async () => {
    const failed = await call("boom", []);
    expect(failed.status).toBe(500);
    expect(failed.body.error.message).toBe("kernel failure");
  });

  it("tells the class about a revocation", async () => {
    let reason = "";
    const response = await serveHostedCall({
      instance: new Kernel(),
      props: hostedProps,
      method: "__hosted/__revoked",
      body: JSON.stringify({ reason: "drain" }),
      onRevoked: async (value) => {
        reason = value;
      },
    });
    expect(response.status).toBe(200);
    expect(reason).toBe("drain");
    expect(isHostedCall("__hosted/x")).toBe(true);
    expect(isHostedCall("getState")).toBe(false);
  });
});

describe("createCodeHostClient", () => {
  const props: CodeHostProps = { codeHost: { name: "root", proof: "p" } };

  it("sends the proof and the exact request, and returns the decoded result", async () => {
    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const env = {
      CODE_HOST: {
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          seen.push({ headers: init.headers as Record<string, string>, body });
          return body["op"] === "call"
            ? Response.json({ result: { value: 7 } })
            : Response.json({ hosted: true });
        },
      },
    };
    const host = createCodeHostClient({ env, props });
    const kernel = await host({ name: "repl", executable: { source: "w/k", className: "K" } });
    expect(await kernel.call("run", "1 + 6", { a: 1 })).toEqual({ value: 7 });
    await kernel.release();
    expect(seen.map((entry) => entry.body["op"])).toEqual(["host", "call", "release"]);
    expect(seen[1]!.headers).toEqual({ "X-Code-Host-Name": "root", "X-Code-Host-Proof": "p" });
    expect(seen[1]!.body).toMatchObject({ method: "run", args: ["1 + 6", { a: 1 }], name: "repl" });
  });

  it("carries a limit on the calls made through limited(), and only those", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const env = {
      CODE_HOST: {
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          seen.push(body);
          return body["op"] === "call" ? Response.json({ result: 1 }) : Response.json({ hosted: true });
        },
      },
    };
    const kernel = await createCodeHostClient({ env, props })({
      name: "repl",
      executable: { source: "w/k", className: "K" },
    });
    await kernel.limited({ cpuMs: 5000 }).call("start", {});
    await kernel.call("await", "r1");
    await kernel.limited({ cpuMs: 5000 }).limited({ subRequests: 3 }).call("start", {});
    const calls = seen.filter((body) => body["op"] === "call");
    expect(calls[0]!["limits"]).toEqual({ cpuMs: 5000 });
    expect(calls[1]).not.toHaveProperty("limits");
    expect(calls[2]!["limits"]).toEqual({ cpuMs: 5000, subRequests: 3 });
  });

  it("restarts an instance whose call overruns its budget, and passes an answer through untouched", async () => {
    const seen: string[] = [];
    let answer: (() => Response) | null = null;
    const env = {
      CODE_HOST: {
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { op: string; method?: string };
          seen.push(body.op === "call" ? `call:${body.method}` : body.op);
          if (body.op === "call") {
            if (body.method === "hang") return new Promise<Response>(() => undefined);
            return (answer ?? (() => Response.json({ result: "ok" })))();
          }
          return body.op === "restart" ? Response.json({ restarted: true }) : Response.json({ hosted: true });
        },
      },
    };
    const kernel = await createCodeHostClient({ env, props })({
      name: "repl",
      executable: { source: "w/k", className: "K" },
    });
    expect(await callOrRestart(kernel, 1000, "get", "r1")).toBe("ok");
    await expect(callOrRestart(kernel, 30, "hang")).rejects.toMatchObject({ code: "EUNRESPONSIVE" });
    expect(seen).toEqual(["host", "call:get", "call:hang", "restart"]);
    // An application failure is not an unresponsive instance: no restart.
    answer = () =>
      Response.json({ error: serializeRpcFailure(new Error("nope")) }, { status: 500 });
    await expect(callOrRestart(kernel, 1000, "get", "r1")).rejects.toThrow("nope");
    expect(seen.filter((entry) => entry === "restart")).toHaveLength(1);
  });

  it("derives a call's CPU limit from a run's timeoutMs, and none without a usable one", () => {
    expect(cpuLimitForTimeout(12_345)).toEqual({ cpuMs: 12_345 });
    expect(cpuLimitForTimeout(0.4)).toEqual({ cpuMs: 1 });
    for (const none of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5"])
      expect(cpuLimitForTimeout(none)).toBeUndefined();
  });

  it("rejects an entity without a binding, a refused request and a hosted failure", async () => {
    await expect(
      createCodeHostClient({ env: {}, props })({
        name: "repl",
        executable: { source: "w/k", className: "K" },
      })
    ).rejects.toMatchObject({ code: "EUNAVAILABLE" });
    const refused = createCodeHostClient({
      env: { CODE_HOST: { fetch: async () => new Response("Forbidden", { status: 403 }) } },
      props,
    });
    await expect(
      refused({ name: "repl", executable: { source: "w/k", className: "K" } })
    ).rejects.toMatchObject({ code: "EACCES" });
    const failing = createCodeHostClient({
      env: {
        CODE_HOST: {
          fetch: async (_url: string, init: RequestInit) =>
            JSON.parse(String(init.body)).op === "call"
              ? Response.json(
                  { error: serializeRpcFailure(new Error("kernel failure")) },
                  { status: 500 }
                )
              : Response.json({ hosted: true }),
        },
      },
      props,
    });
    const kernel = await failing({ name: "repl", executable: { source: "w/k", className: "K" } });
    await expect(kernel.call("boom")).rejects.toThrow("kernel failure");
  });
});

class Plain extends DurableObjectBase {
  protected createTables(): void {}
  selfId(): string {
    return this.rpcSelfId;
  }
  kernel() {
    return this.hostCode({ name: "k", executable: { source: "w/k", className: "K" } });
  }
}

describe("a product class has no per-object props", () => {
  it("still has an identity, and cannot host code", async () => {
    const { instance } = await createTestDO(Plain, {
      WORKER_SOURCE: "s",
      WORKER_CLASS_NAME: "C",
      __objectKey: "k1",
    });
    (instance as unknown as { ctx: { props: unknown } }).ctx.props = undefined;
    expect(instance.selfId()).toBe("do:s:C:k1");
    await expect(instance.kernel()).rejects.toMatchObject({ code: "EUNAVAILABLE" });
  });
});
