export const MAX_UNIT_ICON_BYTES = 1024 * 1024;

/**
 * Resolve the one image asset a unit manifest declares as its icon.
 *
 * Build emission and direct icon serving share this rule so the lightweight
 * presentation path cannot accept an asset the canonical build would reject.
 * Emoji/data icons have no workspace file and therefore return null.
 */
export function declaredUnitIconPath(manifest: { icon?: unknown }): string | null {
  const icon = manifest.icon;
  if (typeof icon !== "string" || !icon.startsWith("./")) return null;

  const artifactPath = icon.slice(2);
  if (
    artifactPath.length === 0 ||
    artifactPath.startsWith("/") ||
    artifactPath.includes("\\") ||
    artifactPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`vibestudio.icon escapes the unit source: ${icon}`);
  }
  return artifactPath;
}

export function assertUnitIconSize(icon: string, byteLength: number): void {
  if (byteLength > MAX_UNIT_ICON_BYTES) {
    throw new Error(`vibestudio.icon exceeds ${MAX_UNIT_ICON_BYTES} bytes: ${icon}`);
  }
}
