import type { DORef } from "@vibestudio/shared/doDispatcher";
import { isInternalDOSource } from "./internalDOs/internalDoLoader.js";

import { DO_EXECUTABLE_VERSION_HEADER } from "./workerdPrograms/executableVersion.js";
export { DO_EXECUTABLE_VERSION_HEADER };
export type DoExecutableVersionResolver = (ref: DORef) => string | null;

/** The admitted host dispatch chooses the executable, before crossing workerd. */
export function doExecutableHeaders(
  ref: DORef,
  resolveVersion: DoExecutableVersionResolver | undefined
): Record<string, string> {
  if (isInternalDOSource(ref.source)) return {};
  const version = resolveVersion?.(ref);
  if (!version)
    throw new Error(`No executable bound to ${ref.source}:${ref.className}/${ref.objectKey}`);
  return { [DO_EXECUTABLE_VERSION_HEADER]: version };
}
