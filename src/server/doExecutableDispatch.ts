import type { DORef } from "@vibestudio/shared/doDispatcher";
import { isInternalDOSource } from "./internalDOs/internalDoLoader.js";
import {
  DO_EXECUTABLE_VERSION_HEADER,
  DO_INCARNATION_VERSION_HEADER,
  type DoExecutableAdmission,
} from "./workerdPrograms/executableVersion.js";
export { DO_EXECUTABLE_VERSION_HEADER, DO_INCARNATION_VERSION_HEADER };
export type { DoExecutableAdmission };
export type DoExecutableAdmissionResolver = (ref: DORef) => DoExecutableAdmission | null;

const admissionHeaders = new WeakMap<DoExecutableAdmission, Readonly<Record<string, string>>>();

/** Capture code identity and object configuration together before crossing workerd. */
export function doExecutableHeaders(
  ref: DORef,
  resolveAdmission: DoExecutableAdmissionResolver | undefined
): Readonly<Record<string, string>> {
  if (isInternalDOSource(ref.source)) return {};
  const admission = resolveAdmission?.(ref);
  if (!admission)
    throw new Error(`No executable bound to ${ref.source}:${ref.className}/${ref.objectKey}`);
  const cached = admissionHeaders.get(admission);
  if (cached) return cached;
  const headers = Object.freeze({
    [DO_EXECUTABLE_VERSION_HEADER]: admission.executableVersion,
    [DO_INCARNATION_VERSION_HEADER]: admission.incarnationVersion,
  });
  admissionHeaders.set(admission, headers);
  return headers;
}
