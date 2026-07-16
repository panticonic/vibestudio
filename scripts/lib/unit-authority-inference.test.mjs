import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  declaredMethodCapabilityDependencies,
  expandCapabilityDependencies,
} from "./unit-authority-inference.mjs";

describe("declared host-method capability dependencies", () => {
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
                  capability: "userland-service:*",
                  requirement: { kind: "selected", principals: ["code"] },
                },
              ],
            },
          },
        },
      },
    });
    assert.deepEqual(
      [...(dependencies.get("service:runtime.create") ?? [])],
      ["context.boundary"]
    );
  });
});
