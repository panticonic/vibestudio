import {
  RELEASES_FEED,
  macReleaseDownload,
  windowsReleaseDownload,
} from "../../../packages/shared/src/releaseDownloads";

/** Resolve the published installer instead of guessing a versioned filename. */
export async function handleDesktopDownload(platform: "mac" | "windows"): Promise<Response> {
  const label = platform === "mac" ? "Mac" : "Windows";
  try {
    const release = await fetch(RELEASES_FEED, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Vibestudio downloads" },
    });
    if (!release.ok) throw new Error(`Release lookup returned HTTP ${release.status}`);
    const payload: unknown = await release.json();
    const installer =
      platform === "mac" ? macReleaseDownload(payload) : windowsReleaseDownload(payload);
    if (!installer)
      throw new Error(`The ${label} installer has not been published for the latest release.`);
    return new Response(null, {
      status: 302,
      headers: { location: installer, "cache-control": "no-store" },
    });
  } catch (error) {
    console.error(`${label} download unavailable`, error);
    return new Response(
      `The ${label} download is unavailable. Please try again later or visit https://github.com/panticonic/vibestudio/releases.`,
      {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      }
    );
  }
}
