import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { parse } from "@babel/parser";
import {
  HOST_BRAND_RUNTIME_ARTIFACTS,
  SOURCE_SERVER_PREREQUISITE_ARTIFACTS,
} from "./server-runtime-artifacts.mjs";
import { copySqlJsRuntimeAsset } from "./lib/sql-js-runtime-asset.mjs";

const buildSource = fs.readFileSync(new URL("../build.mjs", import.meta.url), "utf8");
const buildAst = parse(buildSource, { sourceType: "module" });

function functionCalls(name) {
  const declaration = buildAst.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === name
  );
  assert.ok(declaration, `Expected function declaration ${name}`);
  const calls = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      calls.push(node.callee.name);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(declaration.body);
  return calls;
}

test("warm host reuse runs publication checks only when the canonical generation is absent", () => {
  for (const name of ["build", "buildSourceServerPrerequisites"]) {
    const declaration = buildAst.program.body.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === name
    );
    const statements = declaration.body.body.find((node) => node.type === "TryStatement").block
      .body;
    const warm = statements.find(
      (node) =>
        node.type === "IfStatement" &&
        node.test.type === "CallExpression" &&
        node.test.callee.name === "sameHostBuildFingerprint"
    );
    assert.ok(warm);
    const admission = warm.consequent.body.find((node) => node.type === "IfStatement");
    assert.equal(admission.test.type, "UnaryExpression");
    assert.equal(admission.test.operator, "!");
    assert.equal(admission.test.argument.callee.name, "admitPublishedHostBuildGeneration");
    const guarded = buildSource.slice(admission.consequent.start, admission.consequent.end);
    assert.match(guarded, /publishHostBuildGeneration/u);
    if (name === "build") assert.match(guarded, /await checkBuildArtifacts\(\)/u);
    const outside = warm.consequent.body
      .filter((node) => node !== admission)
      .map((node) => buildSource.slice(node.start, node.end))
      .join("\n");
    assert.doesNotMatch(outside, /checkBuildArtifacts|publishHostBuildGeneration/u);
  }
});

test("the SQL.js runtime payload is part of source host prerequisites", () => {
  assert.ok(SOURCE_SERVER_PREREQUISITE_ARTIFACTS.includes("dist/sql-wasm.wasm"));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-host-assets-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    copySqlJsRuntimeAsset(dist);

    const require = createRequire(import.meta.url);
    assert.deepEqual(
      fs.readFileSync(path.join(dist, "sql-wasm.wasm")),
      fs.readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"))
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct host brand consumers are part of source host prerequisites", () => {
  assert.deepEqual(HOST_BRAND_RUNTIME_ARTIFACTS, [
    "dist/assets/brand/favicon.ico",
    "dist/assets/brand/favicon-32.png",
    "dist/assets/brand/favicon-64.png",
    "dist/assets/brand/favicon-180.png",
    "dist/assets/brand/favicon.svg",
    "dist/assets/brand/vibestudio-symbol.svg",
    "dist/assets/brand/vibestudio-symbol-dark.svg",
    "dist/assets/brand/vibestudio-symbol-512.png",
  ]);
  for (const artifact of HOST_BRAND_RUNTIME_ARTIFACTS) {
    assert.ok(SOURCE_SERVER_PREREQUISITE_ARTIFACTS.includes(artifact));
  }

  const sourceCalls = functionCalls("buildSourceServerPrerequisites");
  assert.ok(
    sourceCalls.indexOf("copyBrandAssets") < sourceCalls.indexOf("assertHostBuildPayloadComplete")
  );
  assert.ok(functionCalls("copyAssets").includes("copyBrandAssets"));
});

test("both host producers stage and validate payloads before stamping their completion receipt", () => {
  const sourceCalls = functionCalls("buildSourceServerPrerequisites");
  assert.ok(
    sourceCalls.indexOf("copySqlJsRuntimeAsset") <
      sourceCalls.indexOf("assertHostBuildPayloadComplete")
  );
  assert.ok(
    sourceCalls.indexOf("assertHostBuildPayloadComplete") <
      sourceCalls.lastIndexOf("writeHostBuildFingerprint")
  );
  assert.ok(
    sourceCalls.lastIndexOf("writeHostBuildFingerprint") <
      sourceCalls.lastIndexOf("publishHostBuildGeneration")
  );

  const desktopCalls = functionCalls("build");
  assert.ok(
    desktopCalls.indexOf("copyAssets") < desktopCalls.indexOf("assertHostBuildPayloadComplete")
  );
  assert.ok(
    desktopCalls.indexOf("assertHostBuildPayloadComplete") <
      desktopCalls.lastIndexOf("writeHostBuildFingerprint")
  );
  assert.ok(
    desktopCalls.lastIndexOf("writeHostBuildFingerprint") <
      desktopCalls.lastIndexOf("publishHostBuildGeneration")
  );
  assert.ok(functionCalls("copyAssets").includes("copySqlJsRuntimeAsset"));
});
