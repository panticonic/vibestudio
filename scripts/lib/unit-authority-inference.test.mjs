import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  inferEventsClientCapabilities,
  inferDirectRpcCapabilities,
  inferExtensionContextCapabilities,
  inferHostedRuntimeCapabilities,
  inferTypedServiceClientCapabilities,
  inferWorkspaceServiceCapabilities,
  declaredMethodCapabilityDependencies,
  expandCapabilityDependencies,
} from "@vibestudio/shared/unitAuthorityInference";

describe("inferWorkspaceServiceCapabilities", () => {
  const selectors = new Map([
    ["development", "workspace-service:development"],
    ["vibestudio.development.v1", "workspace-service:development"],
    ["vibestudio.channel.v1", "workspace-service:channel"],
  ]);

  it("charges known protocol literals hidden behind Durable Object clients", () => {
    assert.deepEqual(
      [
        ...inferWorkspaceServiceCapabilities(
          `createDurableObjectServiceClient(rpc, "vibestudio.development.v1")`,
          selectors
        ),
      ],
      ["workspace-service:development"]
    );
  });

  it("resolves local protocol constants and direct resolver calls", () => {
    assert.deepEqual(
      [
        ...inferWorkspaceServiceCapabilities(
          `
            const CHANNEL_PROTOCOL = "vibestudio.channel.v1";
            const channel = createDurableObjectServiceClient(CHANNEL_PROTOCOL, objectKey);
            await workers.resolveService("development");
          `,
          selectors
        ),
      ].sort(),
      ["workspace-service:channel", "workspace-service:development"]
    );
  });

  it("charges service-backed runtime facades and canonical client constructors", () => {
    const serviceBackedSelectors = new Map([
      ...selectors,
      ["browser.data", "workspace-service:browser.data"],
      ["gad.workspace", "workspace-service:gad.workspace"],
    ]);
    assert.deepEqual(
      [
        ...inferWorkspaceServiceCapabilities(
          `
            const direct = createBrowserDataClient(rpc);
            await browserData.getPasswords();
            await gad.readContext("ctx");
          `,
          serviceBackedSelectors
        ),
      ].sort(),
      ["workspace-service:browser.data", "workspace-service:gad.workspace"]
    );
  });
});

function sourceTreeContains(directory, pattern) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      if (sourceTreeContains(child, pattern)) return true;
    } else if (
      /\.(?:ts|tsx|js|jsx)$/.test(entry.name) &&
      pattern.test(fs.readFileSync(child, "utf8"))
    ) {
      return true;
    }
  }
  return false;
}

describe("inferTypedServiceClientCapabilities", () => {
  const host = new Set([
    "service:autofill.confirmSave",
    "service:autofill.listSavedPasswords",
    "service:autofill.deleteSavedPassword",
  ]);

  it("charges selected methods, not every method in the client's schema", () => {
    const inferred = inferTypedServiceClientCapabilities(
      `
        const autofillClient = createTypedServiceClient("autofill", autofillMethods, call);
        export const autofill = {
          confirmSave: (panelId, action) => autofillClient.confirmSave(panelId, action),
        };
      `,
      host
    );

    assert.deepEqual([...inferred], ["service:autofill.confirmSave"]);
  });

  it("walks deeply generated executable syntax without consuming the JavaScript stack", () => {
    const generatedExpression = `root${".value".repeat(12_000)}`;
    const inferred = inferTypedServiceClientCapabilities(
      `
        declare const root: any;
        const generated = ${generatedExpression};
        const autofillClient = createTypedServiceClient("autofill", methods, call);
        autofillClient.confirmSave("panel", "save");
      `,
      host
    );

    assert.deepEqual([...inferred], ["service:autofill.confirmSave"]);
  });
});

describe("hosted runtime service-backed methods", () => {
  it("maps native browser-data methods to the Electron-resident service", () => {
    const host = new Set([
      "service:browserEnvironment.listDownloads",
      "service:browserEnvironment.pauseDownload",
    ]);
    assert.deepEqual(
      [
        ...inferHostedRuntimeCapabilities(
          `await browserData.listDownloads(); await browserData.pauseDownload("id");`,
          host
        ),
      ].sort(),
      ["service:browserEnvironment.listDownloads", "service:browserEnvironment.pauseDownload"]
    );
  });
});

describe("inferDirectRpcCapabilities", () => {
  const direct = new Set(["rpc:publish", "rpc:subscribe", "rpc:subscribeChannel", "rpc:unknown"]);

  it("infers unary and streaming methods from the same direct-RPC boundary", () => {
    const inferred = inferDirectRpcCapabilities(
      `
        rpc.call(target, "publish", [message]);
        rpc.call(target, "subscribeChannel", [config]);
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

describe("ExtensionContext operational reporting", () => {
  const host = new Set([
    "service:runtime.supervision.appendLog",
    "service:runtime.supervision.reportHealth",
  ]);

  it("maps log and health facades to their actual supervision RPC methods", () => {
    assert.deepEqual(
      [
        ...inferExtensionContextCapabilities(
          `
            ctx.log.info("ready");
            ctx.health.healthy({ summary: "ready" });
          `,
          host
        ),
      ].sort(),
      ["service:runtime.supervision.appendLog", "service:runtime.supervision.reportHealth"]
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
  it("seals context-boundary authority into the workspace navigation commit", () => {
    const matrix = JSON.parse(
      fs.readFileSync(
        new URL("../../src/server/services/__serviceAuthorityMatrix.golden.json", import.meta.url),
        "utf8"
      )
    );
    const dependencies = declaredMethodCapabilityDependencies(matrix);
    assert.deepEqual(
      [...(dependencies.get("service:workspace-state.slot.commitPreparedNavigation") ?? [])],
      ["context.boundary"]
    );
  });

  it("keeps every shipped panel-navigation manifest closed over its semantic commit", () => {
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
        if (requests.has("workspace.runtime-state.manage") && !requests.has("context.boundary")) {
          missing.push(`${root}/${entry.name}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it("declares semantic navigation authority for every buildPanelLink caller", () => {
    const missing = [];
    for (const root of ["about", "apps", "panels"]) {
      const directory = new URL(`../../workspace/${root}/`, import.meta.url);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const unitDirectory = new URL(`${entry.name}/`, directory);
        const manifestUrl = new URL("package.json", unitDirectory);
        if (
          !fs.existsSync(manifestUrl) ||
          !sourceTreeContains(unitDirectory, /\bbuildPanelLink\b/)
        ) {
          continue;
        }
        const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
        const requests = new Set(
          (manifest.vibestudio?.authority?.requests ?? []).map((request) => request.capability)
        );
        if (!requests.has("workspace.runtime-state.manage")) missing.push(`${root}/${entry.name}`);
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
                  capabilityPrefix: "workspace-service:",
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

  it("adds schema-owned conditional approval effects for handler-mediated authority", () => {
    const dependencies = declaredMethodCapabilityDependencies({
      credentials: {
        methods: {
          resolveCredential: {
            authority: { inherits: true },
            access: {
              approval: [{ capability: "credential.use", tier: "gated" }],
            },
          },
        },
      },
    });
    assert.deepEqual(
      [...(dependencies.get("service:credentials.resolveCredential") ?? [])],
      ["credential.use"]
    );
  });
});
