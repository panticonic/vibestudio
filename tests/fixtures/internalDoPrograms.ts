import {
  InternalDOPrograms,
  INTERNAL_DO_CLASSES,
} from "../../src/server/internalDOs/internalDoLoader.js";
export function internalDoProgramsForFixture(label = "fixture"): InternalDOPrograms {
  return InternalDOPrograms.fromCompiler(
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
