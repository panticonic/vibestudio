/**
 * Every egress path of an agent-owned eval that brings outside content into the
 * task reports it to the owning agent, through the one transport all of them
 * share. The agent drops its standing task authority on that report, as it does
 * when its own tools ingest the content.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import { ExecutionJournal } from "./executionJournal.js";
import { EvalDO } from "./EvalDO.js";

const AGENT = "do:workers/agent:Agent:key";
const CHANNEL = "chan-1";

function priv<T = unknown>(instance: object, key: string): T {
  return (instance as unknown as Record<string, unknown>)[key] as T;
}

async function harness(
  owner: { channelId?: string; agentRef?: string },
  options: { refuseReports?: boolean } = {}
) {
  const { instance } = await createTestDO(EvalDO);
  const wire: string[] = [];
  const execution = {
    contextId: "ctx",
    rpc: {
      call: vi.fn(async (target: string, method: string, _args: unknown[]) => {
        wire.push(`${target} ${method}`);
        // The agent accepts every report; everything else returns a plausible shell.
        if (method === "observeOutsideContent") {
          if (options.refuseReports)
            throw new Error("chatOp: refusing caller — only this agent's own EvalDO");
          return undefined;
        }
        if (method === "credentials.proxyFetch")
          return {
            status: 200,
            statusText: "OK",
            headerPairs: [],
            finalUrl: "https://example.com/",
            bodyBase64: "",
          };
        if (method.startsWith("chromiumFetch.open"))
          return {
            responseId: "11111111-1111-4111-8111-111111111111",
            url: "https://example.com/",
            status: 200,
            statusText: "OK",
            headers: {},
            size: 0,
          };
        return null;
      }),
      stream: vi.fn(async (target: string, method: string) => {
        wire.push(`${target} ${method}`);
        return new Response("");
      }),
      streamReadable: vi.fn(),
    },
    operationJournal: new ExecutionJournal(),
  };
  let panelRpc!: { call: (...args: unknown[]) => Promise<unknown> };
  const support = {
    createPanelRuntime: (options: Record<string, unknown>) => {
      panelRpc = options["rpc"] as typeof panelRpc;
      return {};
    },
    createHostedRuntime: (host: Record<string, unknown>) => ({ rpc: host["rpc"] }),
    createRuntimeSelfHandle: () => ({}),
    createGatewayFetch: () => () => undefined,
    createRpcFs: () => ({}),
    createRuntimeParentHandle: () => null,
    createWorkerdClient: () => ({}),
  };
  const runtime = priv<
    (...args: unknown[]) => {
      rpc: {
        call(target: string, method: unknown, args: unknown[]): Promise<unknown>;
        stream(target: string, method: unknown, args: unknown[]): Promise<Response>;
      };
    }
  >(instance, "createRunHostedRuntime").call(
    instance,
    support,
    execution,
    "gateway-token",
    null,
    owner
  );
  const run = <T>(work: () => Promise<T>): Promise<T> =>
    priv<{ run<R>(store: unknown, callback: () => R): R }>(instance, "activeEvalExecution").run(
      execution,
      work
    );
  const reports = () =>
    execution.rpc.call.mock.calls
      .filter(([, method]) => method === "observeOutsideContent")
      .map(([target, , args]) => ({ target, args }));
  return { runtime, panelRpc: () => panelRpc, run, wire, reports };
}

const PROXY_FETCH = [{ url: "https://news.example.com/a", method: "GET" }];

describe("agent-owned eval ingestion of outside content", () => {
  it("reports credentials.fetch's transport, search, and page loads to the owning agent", async () => {
    const h = await harness({ channelId: CHANNEL, agentRef: AGENT });
    await h.run(async () => {
      await h.runtime.rpc.call("main", mainRpcMethods["credentials.proxyFetch"], PROXY_FETCH);
      await h.runtime.rpc.call("main", mainRpcMethods["chromiumFetch.openPublic"], [
        "https://pages.example.org/p",
      ]);
      await h.runtime.rpc.call("main", mainRpcMethods["chromiumFetch.openBrowser"], [
        "https://private.example.com/inbox",
      ]);
    });
    expect(h.reports()).toEqual([
      { target: AGENT, args: [CHANNEL, "web:news.example.com"] },
      { target: AGENT, args: [CHANNEL, "web:pages.example.org"] },
      { target: AGENT, args: [CHANNEL, "web:private.example.com"] },
    ]);
    // Each report follows the call whose response it covers.
    expect(h.wire.slice(0, 2)).toEqual([
      "main credentials.proxyFetch",
      `${AGENT} observeOutsideContent`,
    ]);
  });

  it("reports a streamed git-over-HTTP response before it opens", async () => {
    const h = await harness({ channelId: CHANNEL, agentRef: AGENT });
    await h.run(async () => {
      await h.runtime.rpc.stream("main", mainRpcMethods["credentials.proxyGitHttp"], [
        { url: "https://github.com/o/r.git/info/refs?service=git-upload-pack" },
      ]);
    });
    expect(h.wire).toEqual([`${AGENT} observeOutsideContent`, "main credentials.proxyGitHttp"]);
  });

  it("reports remote Git operations", async () => {
    const h = await harness({ channelId: CHANNEL, agentRef: AGENT });
    await h.run(async () => {
      // The report follows the wire response; the typed answer is checked above it.
      await h.runtime.rpc
        .call("main", mainRpcMethods["gitInterop.pullUpstream"], ["projects/z"])
        .catch(() => undefined);
    });
    expect(h.reports()).toEqual([
      { target: AGENT, args: [CHANNEL, "git:pullUpstream:projects/z"] },
    ]);
  });

  it("reports browser-page reads made through panel handles", async () => {
    const h = await harness({ channelId: CHANNEL, agentRef: AGENT });
    await h.run(async () => {
      await h
        .panelRpc()
        .call("main", mainRpcMethods["panelCdp.getCdpEndpoint"], ["panel:tree/a"])
        .catch(() => undefined);
    });
    expect(h.reports()).toEqual([{ target: AGENT, args: [CHANNEL, "cdp:panel:tree/a"] }]);
  });

  it("does not report calls that bring in nothing from outside", async () => {
    const h = await harness({ channelId: CHANNEL, agentRef: AGENT });
    await h.run(async () => {
      await h.runtime.rpc.call("main", mainRpcMethods["credentials.resolveCredential"], [
        { url: "https://example.com/" },
      ]);
    });
    expect(h.reports()).toEqual([]);
  });

  it("reports nothing for an eval no agent owns, which holds no standing task grants", async () => {
    const h = await harness({});
    await h.run(async () => {
      await h.runtime.rpc.call("main", mainRpcMethods["credentials.proxyFetch"], PROXY_FETCH);
    });
    expect(h.wire).toEqual(["main credentials.proxyFetch"]);
  });

  it("fails the call when the owning agent cannot record the content", async () => {
    const h = await harness({ channelId: CHANNEL, agentRef: AGENT }, { refuseReports: true });
    await expect(
      h.run(() => h.runtime.rpc.call("main", mainRpcMethods["credentials.proxyFetch"], PROXY_FETCH))
    ).rejects.toThrow("only this agent's own EvalDO");
  });
});
