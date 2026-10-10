import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSingleInfrastructureModuleTree } from "./bundle-module-identity.mjs";

const metadata = (...inputs) => ({
  inputs: Object.fromEntries(inputs.map((input) => [input, {}])),
});

test("rejects two infrastructure module trees in the same bundle", () => {
  assert.throws(
    () =>
      assertSingleInfrastructureModuleTree(
        metadata("packages/rpc/src/schemaClient.ts", "packages/rpc/dist/schemaClient.js"),
        "/fixture"
      ),
    /mixes source and compiled modules for @vibestudio\/rpc/
  );
});

test("allows a single tree per package and separate artifact closures", () => {
  assertSingleInfrastructureModuleTree(
    metadata(
      "packages/rpc/src/schemaClient.ts",
      "packages/rpc/src/internal.ts",
      "packages/credential-client/dist/index.js"
    ),
    "/fixture"
  );
  assertSingleInfrastructureModuleTree(metadata("packages/rpc/dist/schemaClient.js"), "/fixture");
});

test("checks package-owned builds relative to their actual working directory", () => {
  assert.throws(
    () =>
      assertSingleInfrastructureModuleTree(
        metadata(
          "../../packages/rpc/src/schemaClient.ts",
          "../../packages/rpc/dist/schemaClient.js"
        ),
        "/fixture",
        "/fixture/apps/headless-host"
      ),
    /mixes source and compiled modules for @vibestudio\/rpc/
  );
});
