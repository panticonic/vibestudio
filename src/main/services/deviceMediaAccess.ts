import { systemPreferences } from "electron";
import type { BrowserSitePermissionCapability } from "@vibestudio/shared/approvals";

/** OS consent is a separate prerequisite, requested only after workspace/site consent. */
export async function requestDeviceMediaAccess(
  capabilities: readonly BrowserSitePermissionCapability[],
  platform: string = process.platform,
  preferences = systemPreferences
): Promise<boolean> {
  if (platform !== "darwin") return true;
  for (const capability of capabilities) {
    if (capability !== "camera" && capability !== "microphone") continue;
    const status = preferences.getMediaAccessStatus(capability);
    if (status === "denied" || status === "restricted") return false;
    if (status === "not-determined" && !(await preferences.askForMediaAccess(capability))) {
      return false;
    }
  }
  return true;
}
