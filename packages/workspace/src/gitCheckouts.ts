import * as path from "node:path";

/**
 * Operational Git checkouts are host state, never workspace source.
 *
 * The checkout may contain an external snapshot that has only been admitted as
 * a semantic integration candidate. Keeping it below statePath prevents disk
 * scanners and source-root consumers from mistaking those bytes for published
 * workspace source.
 */
export function gitCheckoutsPath(statePath: string): string {
  return path.join(statePath, "git-checkouts");
}
