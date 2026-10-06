import { expect, it } from "vitest";
import { macReleaseDownload } from "./releaseDownloads";

it("selects a published Apple Silicon DMG from our release repository", () => {
  const url =
    "https://github.com/panticonic/vibestudio/releases/download/v0.2.0/Vibestudio-0.2.0-arm64.dmg";
  const asset = {
    name: "Vibestudio-0.2.0-arm64.dmg",
    state: "uploaded",
    browser_download_url: url,
  };
  expect(macReleaseDownload({ assets: [asset] })).toBe(url);
  for (const invalid of [
    { ...asset, state: "new" },
    { ...asset, name: "Vibestudio-0.2.0-arm64.zip" },
    { ...asset, browser_download_url: "https://example.com/Vibestudio-arm64.dmg" },
    null,
  ]) {
    expect(macReleaseDownload({ assets: [invalid] })).toBeUndefined();
  }
});
