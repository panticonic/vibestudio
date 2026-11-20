import {
  InternalDOPrograms,
  INTERNAL_DO_CLASSES,
} from "../../src/server/internalDOs/internalDoLoader.js";
import {
  RUNTIME_APP_HOST_EXPORTS,
  captureRuntimeApp,
  type CompiledRuntimeApp,
} from "../../scripts/lib/runtime-app.mjs";

/** Fixtures publish genuine producer output, then enter the actual installed
 * consumer through its existing global coordinate. No test factory ships. */
export function internalDoProgramsFromCompiler(compiled: CompiledRuntimeApp): InternalDOPrograms {
  if (process.env["VIBESTUDIO_RUNTIME_APP_PATH"] !== undefined)
    throw new Error("Internal DO fixture cannot replace an active hub snapshot coordinate");
  const publication = captureRuntimeApp(compiled);
  const key = "__VIBESTUDIO_RUNTIME_APP__";
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
    else delete globalThis.__VIBESTUDIO_RUNTIME_APP__;
  }
}

export function internalDoProgramsForFixture(label = "fixture"): InternalDOPrograms {
  return internalDoProgramsFromCompiler({
    bundle:
      INTERNAL_DO_CLASSES.map((className) => `export class ${className} {}`).join("\n") +
      `\nexport default {}; // ${label}\n`,
    exports: [...RUNTIME_APP_HOST_EXPORTS, ...INTERNAL_DO_CLASSES],
  });
}
