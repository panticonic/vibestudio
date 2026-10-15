import {
  InternalDOPrograms,
  INTERNAL_DO_CLASSES,
} from "../../src/server/internalDOs/internalDoLoader.js";
import {
  captureInternalDoPrograms,
  type CompiledInternalDoProgram,
} from "../../scripts/lib/internal-do-programs.mjs";

/** Fixtures publish genuine producer output, then enter the actual installed
 * consumer through its existing global coordinate. No test factory ships. */
export function internalDoProgramsFromCompiler(
  compiled: Readonly<Record<string, CompiledInternalDoProgram>>
): InternalDOPrograms {
  if (process.env["VIBESTUDIO_INTERNAL_DO_PROGRAMS_PATH"] !== undefined)
    throw new Error("Internal DO fixture cannot replace an active hub snapshot coordinate");
  const publication = captureInternalDoPrograms(compiled);
  const key = "__VIBESTUDIO_INTERNAL_DO_PROGRAMS__";
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  try {
    Object.defineProperty(globalThis, key, {
      value: publication,
      writable: true,
      configurable: true,
    });
    return InternalDOPrograms.readInstalled();
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis.__VIBESTUDIO_INTERNAL_DO_PROGRAMS__;
  }
}

export function internalDoProgramsForFixture(label = "fixture"): InternalDOPrograms {
  return internalDoProgramsFromCompiler(
    Object.fromEntries(
      INTERNAL_DO_CLASSES.map((className) => [
        className,
        {
          bundle: `export class ${className} {} // ${label}\n`,
          exports: [className],
        },
      ])
    )
  );
}
