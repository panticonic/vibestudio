export const RELEASES_FEED = "https://api.github.com/repos/panticonic/vibestudio/releases/latest";

/** Only published installers from our release repository are download targets. */
export function macReleaseDownload(payload: unknown): string | undefined {
  return releaseInstallerDownload(payload, "-arm64.dmg");
}

export function windowsReleaseDownload(payload: unknown): string | undefined {
  return releaseInstallerDownload(payload, ".exe");
}

function releaseInstallerDownload(payload: unknown, suffix: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const assets = (payload as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return undefined;
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") continue;
    const { name, browser_download_url: url, state } = asset;
    if (typeof name !== "string" || !name.endsWith(suffix) || state !== "uploaded") continue;
    if (
      typeof url !== "string" ||
      !url.startsWith("https://github.com/panticonic/vibestudio/releases/download/")
    )
      continue;
    return url;
  }
  return undefined;
}
