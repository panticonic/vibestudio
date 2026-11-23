import { afterEach, describe, expect, it, vi } from "vitest";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { vcsMethods as freshMethods } from "../../packages/service-schemas/src/vcs.js";
import { AmbiguousDoDispatchError as FreshDispatchError } from "../../packages/shared/src/doDispatcher.js";
import { AmbiguousDoDispatchError } from "@vibestudio/shared/doDispatcher";
import { createWorkspaceSemanticPort, createWorkspaceSourceProviderV1 } from "./workspaceSourceProvider.js";
import { dispatchWorkspaceSourceRead, isPinnedWorkspaceRead } from "./workspaceSourceReadRecovery.js";

const provider = { source: "workers/workspace-source", className: "GadWorkspaceDO", objectKey: "workspace" };
const state = { kind: "event" as const, eventId: "event:exact-source" };
const request = () => ({
  input: { state: { ...state }, files: [{ repositoryId: "repo:one", file: { kind: "id" as const, fileId: "file:one" } }] },
  ingress: { causalParent: null },
});
const reset = () => new AmbiguousDoDispatchError("read ECONNRESET", Object.assign(new Error("socket reset"), {
  code: "ECONNRESET",
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("versioned workspace read transport recovery", () => {
  it("loads workspace schema and transport error modules from this successor", () => {
    expect(vcsMethods).toBe(freshMethods);
    expect(AmbiguousDoDispatchError).toBe(FreshDispatchError);
  });
  it("redispatches the exact typed source request and receiver target after one reset", async () => {
    const report = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = request();
    const target = { ...provider };
    const observed: unknown[] = [];
    const dispatch = vi.fn(async (ref: typeof provider, method: string, ...args: unknown[]) => {
      observed.push(structuredClone({ ref, method, args }));
      if (observed.length === 1) {
        original.input.state.eventId = "event:mutated-caller";
        target.objectKey = "changed-caller-target";
        (args[0] as ReturnType<typeof request>).input.state.eventId = "event:mutated-receiver";
        throw reset();
      }
      return { kind: "complete", result: [null] };
    });
    const port = createWorkspaceSemanticPort({ dispatch }, target);
    await expect(port.vcsReadFiles(original)).resolves.toEqual({ kind: "complete", result: [null] });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(observed[1]).toEqual(observed[0]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(report.mock.calls[0]?.[1]))).toMatchObject({
      method: "vcsReadFiles", attempt: 1, attempts: 2, retry: true,
      failure: { code: "AMBIGUOUS_DO_DISPATCH", cause: { code: "ECONNRESET" } },
    });
  });

  it("shares the exact-event read policy with the bootstrap source adapter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatch = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce(null);
    const bootstrap = createWorkspaceSourceProviderV1({ dispatch }, provider);
    await expect(bootstrap.readTemplateInstallation({ eventId: "event:installation" })).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]).toEqual(dispatch.mock.calls[0]);
  });

  it("preserves both failed transport attempts on exhaustion", async () => {
    const report = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = reset(), second = reset();
    const dispatch = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const result = dispatchWorkspaceSourceRead(provider, "vcsReadFiles", [request()], dispatch);
    await expect(result).rejects.toMatchObject({
      code: "VCS_READ_TRANSPORT_EXHAUSTED", errorKind: "transport", errors: [first, second], cause: second,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const events = report.mock.calls.map(call => JSON.parse(String(call[1])));
    expect(events.map(e => [e.attempt, e.retry])).toEqual([[1, true], [2, false]]);
    expect(events[0].requestDigest).toBe(events[1].requestDigest);
  });

  it.each([
    ["vcsReadFile", { input: { state }, ingress: { causalParent: null } }],
    ["vcsReadFiles", request()],
    ["vcsListFiles", { input: { state }, ingress: { causalParent: null } }],
    ["vcsListDirectory", { input: { state }, ingress: { causalParent: null } }],
    ["vcsResolveRepository", { input: { state }, ingress: { causalParent: null } }],
    ["vcsReferencesReachable", { contextIds: ["ctx:one"], references: [{ kind: "state-node", value: state }] }],
    ["vcsIsStateDescendant", { ancestor: state, descendant: state, maxEdges: 100 }],
  ])("recognizes the immutable or receiver-authorized read contract for %s", (method, input) => {
    expect(isPinnedWorkspaceRead(method, [input])).toBe(true);
  });

  it.each(["vcsEdit", "vcsCopy", "vcsCommit", "vcsStatus", "vcsMainState", "vcsSemanticHostReadAck",
    "vcsSemanticContentAck", "vcsDropContext", "resolveSource", "workspaceSourceResolve",
    "workspaceSourceInitializeExactSnapshot", "workspaceSourceCurrent", "workspaceSourceInspectInitialization"])("does not replay %s", async method => {
    const failure = reset();
    const dispatch = vi.fn().mockRejectedValue(failure);
    await expect(dispatchWorkspaceSourceRead(provider, method, [request()], dispatch)).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.assign(new Error("denied"), { code: "EACCES", errorKind: "access" }),
    Object.assign(new Error("stale source"), { code: "ESTALE", errorKind: "service" }),
    Object.assign(new Error("bad response"), { errorKind: "protocol" }),
    new Error("application failure"),
    Object.assign(new Error("caller cancelled"), { name: "AbortError", code: "ABORT_ERR" }),
    Object.assign(new Error("domain network code without dispatch ambiguity"), { code: "ECONNRESET" }),
    new AmbiguousDoDispatchError("not a reset", Object.assign(new Error("cancelled"), { code: "RPC_ABORTED" })),
    new AggregateError([reset(), new Error("independent semantic failure")], "compound failure"),
    new AmbiguousDoDispatchError("wrapped semantic refusal", Object.assign(new Error("stale source"), {
      code: "ESTALE", cause: reset(),
    })),
  ])("preserves non-recoverable verdict %s", async failure => {
    const dispatch = vi.fn().mockRejectedValue(failure);
    await expect(dispatchWorkspaceSourceRead(provider, "vcsReadFiles", [request()], dispatch)).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("propagates a fresh receiver authorization refusal after a transport reset", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const denied = Object.assign(new Error("context access was revoked"), { code: "EACCES", errorKind: "access" });
    const dispatch = vi.fn().mockRejectedValueOnce(reset()).mockRejectedValueOnce(denied);
    await expect(dispatchWorkspaceSourceRead(provider, "vcsReadFiles", [request()], dispatch)).rejects.toBe(denied);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("supports explicit opt-out and refuses an unpinned selector", async () => {
    vi.stubEnv("VIBESTUDIO_RETRY_PINNED_READS", "0");
    const failure = reset();
    const dispatch = vi.fn().mockRejectedValue(failure);
    await expect(dispatchWorkspaceSourceRead(provider, "vcsReadFiles", [request()], dispatch)).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
    const unpinned = { input: { state: { kind: "current" } }, ingress: { causalParent: null } };
    await expect(dispatchWorkspaceSourceRead(provider, "vcsReadFiles", [unpinned], dispatch)).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
