import { RELEASES_FEED, macReleaseDownload } from "../../../packages/shared/src/releaseDownloads";

/** Resolve the published installer instead of guessing a versioned filename. */
export async function handleMacDownload(): Promise<Response> {
  try {
    const release = await fetch(RELEASES_FEED, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Vibestudio downloads" },
    });
    if (!release.ok) throw new Error(`Release lookup returned HTTP ${release.status}`);
    const installer = macReleaseDownload(await release.json());
    if (!installer)
      throw new Error("The Mac installer has not been published for the latest release.");
    return new Response(null, {
      status: 302,
      headers: { location: installer, "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Mac download unavailable", error);
    return new Response(
      "The Mac download is unavailable. Please try again later or visit https://github.com/panticonic/vibestudio/releases.",
      {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      }
    );
  }
}
