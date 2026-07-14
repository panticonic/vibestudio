import { describe, expect, it } from "vitest";

// @ts-expect-error The production generator is a native Node ESM build script.
import {
  EXTENSION_RUNTIME_BASE_CAPABILITIES,
  inferDirectRpcCapabilities,
  inferExtensionContextCapabilities,
  inferHostedRuntimeCapabilities,
  inferWorkspacePackageReferences,
} from "../scripts/lib/unit-authority-inference.mjs";

const known = new Set([
  "service:events.subscribe",
  "service:events.unsubscribe",
  "service:extensions.invoke",
  "service:extensions.invokeStream",
  "service:extensions.streamingMethods",
  "service:extensions.emit",
  "service:extensions.health",
  "service:extensions.log",
  "service:credentials.proxyGitHttp",
  "service:fs.ensureMaterialized",
  "service:notification.show",
  "service:userlandApproval.request",
  "service:workers.resolveService",
  "service:workspace.ensureContextFolder",
  "service:workspace.getInfo",
  "service:workspace.findUnitForPath",
  "service:workspace.sourceTree",
  "service:workspace.units.list",
]);

describe("unit authority inference for ExtensionContext", () => {
  it("declares the activation handshake emitted for every extension process", () => {
    expect(EXTENSION_RUNTIME_BASE_CAPABILITIES).toEqual([
      "service:extensions.health",
      "service:extensions.ready",
    ]);
  });

  it("maps public facade calls to their exact transport capabilities", () => {
    const source = `
      await ctx.workspace.getInfo();
      await ctx.workspace.ensureContextFolder(contextId);
      await ctx.approvals.request(request);
      await ctx.notifications.show(notification);
      await ctx.workers.resolveService(protocol);
      await ctx.fs.ensureMaterialized?.(target);
      this.ctx.credentials.gitHttp(options);
    `;

    expect([...inferExtensionContextCapabilities(source, known)].sort()).toEqual([
      "service:credentials.proxyGitHttp",
      "service:fs.ensureMaterialized",
      "service:notification.show",
      "service:userlandApproval.request",
      "service:workers.resolveService",
      "service:workspace.ensureContextFolder",
      "service:workspace.getInfo",
    ]);
  });

  it("expands client-local helpers into every host method they can reach", () => {
    expect(
      [...inferExtensionContextCapabilities("ctx.extensions.use(name)", known)].sort()
    ).toEqual([
      "service:extensions.invoke",
      "service:extensions.invokeStream",
      "service:extensions.streamingMethods",
    ]);
  });

  it("maps context lifecycle helpers to extension runtime reporting methods", () => {
    const source = `
      ctx.log.info("started");
      this.ctx.health.degraded({ summary: "waiting" });
      ctx.emit("changed", value);
    `;
    expect([...inferExtensionContextCapabilities(source, known)].sort()).toEqual([
      "service:extensions.emit",
      "service:extensions.health",
      "service:extensions.log",
    ]);
  });

  it("fails closed when a new facade method has no declared host mapping", () => {
    expect(() => inferExtensionContextCapabilities("ctx.workspace.futureMethod()", known)).toThrow(
      "workspace.futureMethod"
    );
  });
});

describe("direct RPC authority inference", () => {
  it("parses computed targets, generics, and multiline method arguments", () => {
    const source = `
      await rpc.call<Result>(
        targetIdFor(handleOrTargetId),
        "subscribeChannel",
        [input],
      );
      await client.callDeferred("unsubscribeChannel", [channel]);
    `;

    expect(
      [
        ...inferDirectRpcCapabilities(
          source,
          new Set(["rpc:subscribeChannel", "rpc:unsubscribeChannel"])
        ),
      ].sort()
    ).toEqual(["rpc:subscribeChannel", "rpc:unsubscribeChannel"]);
  });

  it("follows a local transport wrapper to its literal method call sites", () => {
    const source = `
      const callChannel = async <T>(method: string, ...args: unknown[]): Promise<T> =>
        rpc.call<T>(await resolveTarget(), method, args);

      await callChannel("subscribe", participantId, metadata);
      await callChannel<Result>("getReplayAfter", request);
    `;

    expect(
      [
        ...inferDirectRpcCapabilities(source, new Set(["rpc:getReplayAfter", "rpc:subscribe"])),
      ].sort()
    ).toEqual(["rpc:getReplayAfter", "rpc:subscribe"]);
  });

  it("ignores string arguments that are not reviewed direct-RPC methods", () => {
    expect([
      ...inferDirectRpcCapabilities('rpc.call(target(), "unknownMethod", [])', new Set()),
    ]).toEqual([]);
  });
});

describe("transitive package authority inference", () => {
  it("follows executable workspace imports without treating source text as a dependency", () => {
    const source = `
      import { load } from "@workspace/harness";
      export { helper } from "@workspace/runtime/subpath";
      const optional = import("@workspace/model-catalog");
      const commonJs = require("@workspace/pubsub/client");
      const prose = "@workspace/not-imported";
    `;

    expect(
      [
        ...inferWorkspacePackageReferences(source, [
          "@workspace/harness",
          "@workspace/runtime",
          "@workspace/model-catalog",
          "@workspace/pubsub",
          "@workspace/not-imported",
        ]),
      ].sort()
    ).toEqual([
      "@workspace/harness",
      "@workspace/model-catalog",
      "@workspace/pubsub",
      "@workspace/runtime",
    ]);
  });
});

describe("hosted runtime facade authority inference", () => {
  it("expands an extension proxy and preserves direct extension facade calls", () => {
    const capabilities = new Set([
      "service:extensions.invoke",
      "service:extensions.invokeProvider",
      "service:extensions.invokeStream",
      "service:extensions.streamingMethods",
    ]);
    expect(
      [
        ...inferHostedRuntimeCapabilities(
          `
        const shell = extensions.use("@workspace-extensions/shell");
        await extensions.invokeProvider("claudeCode", "launch", []);
      `,
          capabilities
        ),
      ].sort()
    ).toEqual([
      "service:extensions.invoke",
      "service:extensions.invokeProvider",
      "service:extensions.invokeStream",
      "service:extensions.streamingMethods",
    ]);
  });

  it("maps direct workspace runtime methods to their host services", () => {
    const known = new Set(["service:workspace.sourceTree", "service:workspace.select"]);

    expect(
      [
        ...inferHostedRuntimeCapabilities(
          `
            const vaults = await workspace.sourceTree();
            await workspace.switchTo("other");
          `,
          known
        ),
      ].sort()
    ).toEqual(["service:workspace.select", "service:workspace.sourceTree"]);
  });

  it("expands nested workspace conveniences into their transport dependencies", () => {
    expect(
      [
        ...inferHostedRuntimeCapabilities(
          `
            const current = await workspace.units.list();
            const status = await workspace.units.status();
            for await (const units of workspace.units.watch()) consume(units);
            const projects = await workspace.projects.list();
            await workspace.projects.findForPath(projects[0]);
          `,
          known
        ),
      ].sort()
    ).toEqual([
      "service:events.subscribe",
      "service:events.unsubscribe",
      "service:workspace.findUnitForPath",
      "service:workspace.sourceTree",
      "service:workspace.units.list",
    ]);
  });
});
