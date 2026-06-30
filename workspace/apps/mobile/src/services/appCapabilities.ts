import type { AppCapability } from "@vibez1/shared/unitManifest";

let approvedCapabilities = new Set<AppCapability>();

export function setApprovedAppCapabilities(capabilities: readonly AppCapability[]): void {
  approvedCapabilities = new Set(capabilities);
}

export function hasApprovedAppCapability(capability: AppCapability): boolean {
  return approvedCapabilities.has(capability);
}

export function requireApprovedAppCapability(capability: AppCapability, surface: string): void {
  if (approvedCapabilities.has(capability)) return;
  throw new Error(`${surface} requires approved app capability '${capability}'`);
}
