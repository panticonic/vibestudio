const installers = {
  mac: "Vibestudio-arm64.dmg",
  windows: "Vibestudio-Setup-x64.exe",
} as const;

/** GitHub owns latest-release resolution; installer names stay stable across releases. */
export function handleDesktopDownload(platform: keyof typeof installers): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://github.com/panticonic/vibestudio/releases/latest/download/${installers[platform]}`,
      "cache-control": "no-store",
    },
  });
}
