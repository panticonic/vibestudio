import { createHash } from "node:crypto";
import executionCatalog from "../../src/server/internalDOs/internalDoExecutionCatalog.json" with { type: "json" };

/**
 * The runtime application: ONE ES module that the celld node of a workspace
 * deploys. It holds the router (default export), the worker host and the
 * executable preparation entrypoints, the UniversalDO facet host and every
 * product-owned (internal) Durable Object class. One module means one `ses`
 * copy and one `lockdown()` per isolate family (celld audit V2).
 */
export const RUNTIME_APP_FILE = "runtime-app.json";
export const RUNTIME_APP_FORMAT = "vibestudio-runtime-app/1";
export const INTERNAL_DO_PROGRAM_ENTRIES = Object.freeze(
  Object.entries(executionCatalog.classes).map(([className, entry]) =>
    Object.freeze({ className, implementation: entry.implementation })
  )
);
/** Entrypoints of the host programs, in addition to the internal classes. */
export const RUNTIME_APP_HOST_EXPORTS = Object.freeze([
  "default",
  "WorkerHost",
  "ExecutablePreparation",
  "CodeHost",
  "UniversalDO",
]);
const chronologExports = ["ChronologWorkspaceDO", "ChronologGroupDO"];
const classes = INTERNAL_DO_PROGRAM_ENTRIES.map(({ className }) => className).sort();
const digest = /^[a-f0-9]{64}$/u;

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")
  )
    throw new Error(`Invalid runtime app ${label}`);
}

/** Admit the finite metadata of an already-proved immutable publication.
 * Payload hashes belong exclusively to the producer/publication boundary. */
export function readPublishedRuntimeApp(input) {
  const chronolog = input?.chronolog === true;
  exactKeys(
    input,
    ["format", "bundle", "buildKey", "internalClasses", ...(chronolog ? ["chronolog"] : [])],
    "publication"
  );
  if (input.format !== RUNTIME_APP_FORMAT) throw new Error("Invalid runtime app format");
  if (
    !Array.isArray(input.internalClasses) ||
    [...input.internalClasses].sort().join("\n") !== classes.join("\n")
  )
    throw new Error("Invalid runtime app internal class inventory");
  if (
    typeof input.bundle !== "string" ||
    input.bundle.length === 0 ||
    typeof input.buildKey !== "string" ||
    !digest.test(input.buildKey)
  )
    throw new Error("Invalid runtime app executable metadata");
  return Object.freeze({
    format: input.format,
    bundle: input.bundle,
    buildKey: input.buildKey,
    internalClasses: Object.freeze([...classes]),
    ...(chronolog ? { chronolog: true } : {}),
  });
}

/** The one producer proof, also used by final host artifact publication checks. */
export function assertRuntimeAppPublication(input) {
  // These checks belong to artifact production, not installed metadata admission.
  // Keep their executable sentinels out of consumers of readPublishedRuntimeApp.
  const forbidden = [
    '__require("process")',
    'require("process")',
    "throw Error('Dynamic require of \"",
  ];
  const capture = readPublishedRuntimeApp(input);
  const actual = createHash("sha256").update(capture.bundle).digest("hex");
  if (actual !== capture.buildKey)
    throw new Error("Runtime app build key does not match its exact bytes");
  for (const pattern of forbidden) {
    if (capture.bundle.includes(pattern))
      throw new Error(`Runtime app has forbidden runtime dependency: ${pattern}`);
  }
  return capture;
}

/** Capture the actual compiler output, never invent an export or executable hash. */
export function captureRuntimeApp(compiled) {
  exactKeys(compiled, ["bundle", "exports"], "compiler output");
  const chronolog =
    Array.isArray(compiled.exports) &&
    compiled.exports.some((name) => chronologExports.includes(name));
  const expected = [
    ...RUNTIME_APP_HOST_EXPORTS,
    ...classes,
    ...(chronolog ? chronologExports : []),
  ].sort();
  if (
    !Array.isArray(compiled.exports) ||
    [...compiled.exports].sort().join("\n") !== expected.join("\n")
  )
    throw new Error(
      `Runtime app must export exactly ${expected.join(", ")}; got ${String(compiled.exports)}`
    );
  if (typeof compiled.bundle !== "string" || compiled.bundle.length === 0)
    throw new Error("Runtime app compiler output is empty");
  return assertRuntimeAppPublication({
    format: RUNTIME_APP_FORMAT,
    bundle: compiled.bundle,
    buildKey: createHash("sha256").update(compiled.bundle).digest("hex"),
    internalClasses: classes,
    ...(chronolog ? { chronolog: true } : {}),
  });
}

/**
 * Entry source. Module evaluation order is the contract: every dependency,
 * including each class wrapper, evaluates before the realm is locked down.
 */
export function runtimeAppEntrypointSource({ chronolog = false } = {}) {
  const imports = INTERNAL_DO_PROGRAM_ENTRIES.map(
    ({ className, implementation }, index) =>
      `import { ${className} as Internal${index} } from ${JSON.stringify(implementation)};`
  ).join("\n");
  const exports = INTERNAL_DO_PROGRAM_ENTRIES.map(
    ({ className }, index) =>
      `export const ${className} = internalDurableObjectClass(Internal${index}, ${JSON.stringify(className)});`
  ).join("\n");
  const chronologSource = chronolog
    ? [
        'import { DurableObject } from "cloudflare:workers";',
        'import { encodeRpcJson, decodeRpcJson } from "@vibestudio/rpc";',
        'import { createCelldWorkspaceClasses } from "runtime-app:chronolog";',
        'import { chronologHistoryCarrier } from "./chronologHistoryCarrier.ts";',
        "export const { ChronologWorkspaceDO, ChronologGroupDO } = createCelldWorkspaceClasses({",
        "  DurableObject, socketPair: () => new WebSocketPair(), encode: encodeRpcJson, decode: decodeRpcJson,",
        "  publication: chronologHistoryCarrier,",
        "});",
      ].join("\n") + "\n"
    : "";
  return (
    `import { initializeInternalDORealm } from "../internalDOs/workerdRealm.ts";\n` +
    `import { internalDurableObjectClass } from "./app.ts";\n` +
    `${imports}\n` +
    `export { default, WorkerHost, ExecutablePreparation, CodeHost, UniversalDO } from "./app.ts";\n` +
    `${exports}\n` +
    chronologSource +
    `initializeInternalDORealm();\n`
  );
}
