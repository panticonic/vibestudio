import { MAX_UNIT_ICON_BYTES } from "@vibestudio/shared/panel/icon";
import { validateUnitIconDeclaration } from "@vibestudio/shared/unitManifest";
export { MAX_UNIT_ICON_BYTES } from "@vibestudio/shared/panel/icon";

/**
 * Resolve the one image asset a unit manifest declares as its icon.
 *
 * Build emission and direct icon serving share this rule so the lightweight
 * presentation path cannot accept an asset the canonical build would reject.
 * Emoji icons have no workspace file and therefore return null.
 */
export function declaredUnitIconPath(manifest: { icon?: unknown }): string | null {
  const icon = manifest.icon;
  validateUnitIconDeclaration(icon);
  if (typeof icon !== "string" || !icon.startsWith("./")) return null;
  return icon.slice(2);
}

export function assertUnitIconSize(icon: string, byteLength: number): void {
  if (byteLength > MAX_UNIT_ICON_BYTES) {
    throw new Error(`vibestudio.icon exceeds ${MAX_UNIT_ICON_BYTES} bytes: ${icon}`);
  }
}
