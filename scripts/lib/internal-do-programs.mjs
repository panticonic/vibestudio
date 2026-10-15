import { createHash } from "node:crypto";
import executionCatalog from "../../src/server/internalDOs/internalDoExecutionCatalog.json" with { type: "json" };

export const INTERNAL_DO_PROGRAMS_FILE = "internal-do-programs.json";
export const INTERNAL_DO_PROGRAM_ENTRIES = Object.freeze(
  Object.entries(executionCatalog.classes).map(([className, entry]) =>
    Object.freeze({ className, implementation: entry.implementation })
  )
);
const classes = INTERNAL_DO_PROGRAM_ENTRIES.map(({ className }) => className).sort();
const digest = /^[a-f0-9]{64}$/u;

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")
  )
    throw new Error(`Invalid internal DO ${label}`);
}

/** Admit the finite metadata of an already-proved immutable publication.
 * Payload hashes belong exclusively to the producer/publication boundary. */
export function readPublishedInternalDoPrograms(input) {
  exactKeys(input, ["format", "programs"], "program collection");
  if (input.format !== "vibestudio-internal-do-programs/1")
    throw new Error("Invalid internal DO program collection format");
  exactKeys(input.programs, classes, "program inventory");
  const programs = {};
  for (const className of classes) {
    const program = input.programs[className];
    exactKeys(program, ["bundle", "buildKey"], `${className} program`);
    if (
      typeof program.bundle !== "string" ||
      program.bundle.length === 0 ||
      typeof program.buildKey !== "string" ||
      !digest.test(program.buildKey)
    )
      throw new Error(`Invalid internal DO ${className} executable metadata`);
    programs[className] = Object.freeze({ bundle: program.bundle, buildKey: program.buildKey });
  }
  return Object.freeze({ format: input.format, programs: Object.freeze(programs) });
}

/** The one producer proof, also used by final host artifact publication checks. */
export function assertInternalDoProgramsPublication(input) {
  // These checks belong to artifact production, not installed metadata admission.
  // Keep their executable sentinels out of consumers of readPublishedInternalDoPrograms.
  const forbidden = [
    '__require("process")',
    'require("process")',
    "throw Error('Dynamic require of \"",
  ];
  const capture = readPublishedInternalDoPrograms(input);
  for (const [className, program] of Object.entries(capture.programs)) {
    const actual = createHash("sha256").update(program.bundle).digest("hex");
    if (actual !== program.buildKey)
      throw new Error(`Internal DO ${className} build key does not match its exact bytes`);
    for (const pattern of forbidden) {
      if (program.bundle.includes(pattern))
        throw new Error(
          `Internal DO ${className} has forbidden workerd runtime dependency: ${pattern}`
        );
    }
  }
  return capture;
}

/** Capture actual compiler outputs, never invent an export or executable hash. */
export function captureInternalDoPrograms(compiled) {
  exactKeys(compiled, classes, "compiler output inventory");
  const programs = {};
  for (const className of classes) {
    const output = compiled[className];
    if (output.exports?.length !== 1 || output.exports[0] !== className)
      throw new Error(`Internal DO ${className} must export only its reviewed class`);
    if (typeof output.bundle !== "string" || output.bundle.length === 0)
      throw new Error(`Internal DO ${className} compiler output is empty`);
    programs[className] = {
      bundle: output.bundle,
      buildKey: createHash("sha256").update(output.bundle).digest("hex"),
    };
  }
  return assertInternalDoProgramsPublication({
    format: "vibestudio-internal-do-programs/1",
    programs,
  });
}

/** Preserve entry-body ordering: dependencies evaluate before realm lockdown. */
export function internalDoEntrypointSource(className) {
  const entry = INTERNAL_DO_PROGRAM_ENTRIES.find((entry) => entry.className === className);
  if (!entry || typeof entry.implementation !== "string")
    throw new Error(`Internal Durable Object ${className} is not a reviewed product export`);
  return (
    `import { initializeInternalDORealm } from "./workerdRealm.ts";\n` +
    `export { ${entry.className} } from ${JSON.stringify(entry.implementation)};\n` +
    `initializeInternalDORealm();\n`
  );
}
