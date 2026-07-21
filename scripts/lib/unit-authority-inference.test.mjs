import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  inferEventsClientCapabilities,
  inferDirectRpcCapabilities,
  inferExtensionContextCapabilities,
  inferHostedRuntimeCapabilities,
  declaredMethodCapabilityDependencies,
  expandCapabilityDependencies,
} from "./unit-authority-inference.mjs";

describe("inferDirectRpcCapabilities", () => {
  const direct = new Set(["rpc:publish", "rpc:subscribe", "rpc:subscribeChannel", "rpc:unknown"]);

  it("infers unary and streaming methods from the same direct-RPC boundary", () => {
    const inferred = inferDirectRpcCapabilities(
      `
        rpc.call(target, "publish", [message]);
        rpc.callDeferred(target, "subscribeChannel", [config]);
        rpc.stream(target, "subscribe", [clientId, metadata]);
        rpc.streamReadable(target, "subscribe", [clientId, metadata]);
      `,
      direct
    );

    assert.deepEqual([...inferred].sort(), [
      "rpc:publish",
      "rpc:subscribe",
      "rpc:subscribeChannel",
    ]);
  });

  it("propagates literal method arguments through streaming wrappers", () => {
    const inferred = inferDirectRpcCapabilities(
      `
        const streamTarget = (target, method, args) => rpc.stream(target, method, args);
        streamTarget(targetId, "subscribe", []);
      `,
      direct
    );

    assert.deepEqual([...inferred], ["rpc:subscribe"]);
  });
});

describe("event-backed extension subscriptions", () => {
  const host = new Set(["service:events.watch"]);

  it("maps hosted-runtime extensions.on to its response-owned watch", () => {
    assert.deepEqual(
      [...inferHostedRuntimeCapabilities(`extensions.on("example", "changed", cb)`, host)],
      ["service:events.watch"]
    );
  });

  it("maps ExtensionContext extensions.on to the same watch contract", () => {
    assert.deepEqual(
      [...inferExtensionContextCapabilities(`ctx.extensions.on("example", "changed", cb)`, host)],
      ["service:events.watch"]
    );
  });
});

describe("inferEventsClientCapabilities", () => {
  const services = new Map([
    ["events", ["watch"]],
    ["desktopEvents", ["watch"]],
  ]);

  it("infers both the default and explicitly selected event services", () => {
    const inferred = inferEventsClientCapabilities(
      `
        const portable = new EventsClient(rpc);
        const desktop = new EventsClient(rpc, undefined, "desktopEvents");
      `,
      services
    );

    assert.deepEqual([...inferred].sort(), ["service:desktopEvents.watch", "service:events.watch"]);
  });
});

describe("declared host-method capability dependencies", () => {
  it("seals atomic workspace-state commit authority into panel navigation callers", () => {
    const matrix = JSON.parse(
      fs.readFileSync(
        new URL("../../src/server/services/__serviceAuthorityMatrix.golden.json", import.meta.url),
        "utf8"
      )
    );
    const dependencies = declaredMethodCapabilityDependencies(matrix);
    const expected = ["service:workspace-state.slot.commitPreparedNavigation"];

    assert.deepEqual([...(dependencies.get("service:panelTree.navigate") ?? [])], expected);
    assert.deepEqual([...(dependencies.get("service:panelTree.navigateHistory") ?? [])], expected);
  });

  it("keeps every shipped panel-navigation manifest closed over its atomic commit", () => {
    const missing = [];
    for (const root of ["about", "apps", "panels"]) {
      const directory = new URL(`../../workspace/${root}/`, import.meta.url);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestUrl = new URL(`${entry.name}/package.json`, directory);
        if (!fs.existsSync(manifestUrl)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
        const requests = new Set(
          (manifest.vibestudio?.authority?.requests ?? []).map((request) => request.capability)
        );
        if (
          requests.has("service:panelTree.navigate") &&
          !requests.has("service:workspace-state.slot.commitPreparedNavigation")
        ) {
          missing.push(`${root}/${entry.name}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it("adds code prerequisites transitively to inferred unit authority", () => {
    const dependencies = declaredMethodCapabilityDependencies({
      notification: {
        methods: {
          show: {
            additional: [
              {
                capability: "notifications",
                requirement: {
                  kind: "capability",
                  principal: "code",
                  capability: "notifications",
                },
              },
            ],
          },
        },
      },
    });
    const inferred = expandCapabilityDependencies(
      new Set(["service:notification.show"]),
      dependencies
    );
    assert.deepEqual([...inferred], ["service:notification.show", "notifications"]);
  });

  it("does not request a user-only prerequisite on behalf of code", () => {
    const dependencies = declaredMethodCapabilityDependencies({
      settings: {
        methods: {
          update: {
            additional: [
              {
                capability: "account-admin",
                requirement: {
                  kind: "capability",
                  principal: "user",
                  capability: "account-admin",
                },
              },
            ],
          },
        },
      },
    });
    assert.equal(dependencies.has("service:settings.update"), false);
  });

  it("adds exact schema-owned prepared leaves and excludes dynamic namespace templates", () => {
    const dependencies = declaredMethodCapabilityDependencies({
      runtime: {
        methods: {
          create: {
            prepared: {
              resolver: "runtime.create.authority",
              leaves: [
                {
                  capability: "context.boundary",
                  requirement: { kind: "selected", principals: ["code", "host"] },
                },
                {
                  capability: "workspace-service:*",
                  requirement: { kind: "selected", principals: ["code"] },
                },
              ],
            },
          },
        },
      },
    });
    assert.deepEqual([...(dependencies.get("service:runtime.create") ?? [])], ["context.boundary"]);
  });
});
