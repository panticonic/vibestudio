import assert from "node:assert/strict";
import test from "node:test";
import { mergeHostServiceAuthorityMatrices } from "./host-service-authority-matrices.mjs";

const method = (authority = { inherits: true }) => ({
  authority,
  tier: { tier: "gated" },
  capability: "workspaces.create",
});

test("transport defaults stay attached to their own methods", () => {
  const merged = mergeHostServiceAuthorityMatrices([
    { hubControl: { service: { principals: ["host", "user"] }, methods: { inventory: method() } } },
    { hubControl: { service: { principals: ["website"] }, methods: { receipt: method() } } },
  ]);
  assert.deepEqual(merged.hubControl.methods.inventory.authority, { principals: ["host", "user"] });
  assert.deepEqual(merged.hubControl.methods.receipt.authority, { principals: ["website"] });
});

test("the same explicit contract is shared across distinct transports", () => {
  const authority = { principals: ["host", "user", "code", "website"] };
  const merged = mergeHostServiceAuthorityMatrices([
    { hubControl: { service: { principals: ["host"] }, methods: { create: method(authority) } } },
    {
      hubControl: { service: { principals: ["website"] }, methods: { create: method(authority) } },
    },
  ]);
  assert.deepEqual(Object.keys(merged.hubControl.methods), ["create"]);
  assert.deepEqual(merged.hubControl.methods.create.authority, authority);
});

test("incompatible contracts cannot silently overwrite one another", () => {
  assert.throws(
    () =>
      mergeHostServiceAuthorityMatrices([
        { hubControl: { service: { principals: ["host"] }, methods: { create: method() } } },
        { hubControl: { service: { principals: ["website"] }, methods: { create: method() } } },
      ]),
    /hubControl.create has conflicting transport contracts/
  );
});
