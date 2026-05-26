import { expect, test } from "@playwright/test";

import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  hasElectronDisplay,
  launchTestApp,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

type WebContentsSnapshot = {
  id: number;
  url: string;
  title: string;
  text: string;
  hasTitlebar: boolean;
  hasApprovalBar: boolean;
};

async function listWebContents(testApp: TestApp): Promise<WebContentsSnapshot[]> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const snapshots: WebContentsSnapshot[] = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      const url = contents.getURL();
      const title = contents.getTitle();
      let dom:
        | {
            text: string;
            hasTitlebar: boolean;
            hasApprovalBar: boolean;
          }
        | null = null;
      try {
        dom = await contents.executeJavaScript(
          `({
            text: document.body?.innerText ?? "",
            hasTitlebar: !!document.querySelector(".titlebar-breadcrumb-scroll")
              || !!document.querySelector('[aria-label="Menu"]'),
            hasApprovalBar: !!document.querySelector(".approval-bar"),
          })`,
          true
        );
      } catch {
        dom = null;
      }
      snapshots.push({
        id: contents.id,
        url,
        title,
        text: dom?.text ?? "",
        hasTitlebar: dom?.hasTitlebar ?? false,
        hasApprovalBar: dom?.hasApprovalBar ?? false,
      });
    }
    return snapshots;
  });
}

test.describe("Desktop Shell Chrome", () => {
  test.setTimeout(240_000);

  let testApp: TestApp | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  test("mounts the dynamic shell app with custom titlebar chrome", async () => {
    testApp = await launchTestApp({ launchTimeout: 240_000 });

    await expect
      .poll(
        async () => {
          const snapshots = await listWebContents(testApp!);
          return snapshots.some(
            (snapshot) =>
              snapshot.url.includes("/_a/") &&
              snapshot.url.endsWith("/index.html") &&
              snapshot.hasTitlebar
          );
        },
        { timeout: 120_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);
  });
});
