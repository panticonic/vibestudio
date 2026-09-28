import { expect, test, type Locator } from "@playwright/test";
import type { TestApp } from "../../setup/electronSetup";
import {
  clickWindowPointThroughNativeInput,
  moveWindowPointerThroughNativeInput,
} from "../../setup/nativeInput";

export async function clickNativeApproval(app: TestApp, button: Locator): Promise<void> {
  let target!: { url: string; approvalId: string; x: number; y: number };
  let point!: { x: number; y: number };
  await expect(async () => {
    target = await button.evaluate(async (element) => {
      element.scrollIntoView({ block: "center", inline: "nearest" });
      // Native input uses window coordinates. Wait for the real entrance
      // transform before measuring them, as Playwright's own click does.
      const card = element.closest(".approval-card");
      await Promise.all(
        (card?.getAnimations() ?? [])
          .filter((animation) =>
            Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
          )
          .map((animation) => animation.finished.catch(() => undefined))
      );

      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      const rect = element.getBoundingClientRect();
      return {
        url: location.href,
        approvalId: element.closest("[data-approval-id]")!.getAttribute("data-approval-id")!,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    });
    point = await app.app.evaluate(async ({ BaseWindow }, target) => {
      const matches: Array<{ x: number; y: number }> = [];
      const selector = `[data-approval-id=${JSON.stringify(target.approvalId)}]`;
      const visit = async (view: Electron.View, x: number, y: number) => {
        if (!view.getVisible()) return;
        const bounds = view.getBounds();
        x += bounds.x;
        y += bounds.y;
        if ("webContents" in view) {
          const contents = (view as Electron.WebContentsView).webContents;
          if (
            contents.getURL() === target.url &&
            (await contents.executeJavaScript(
              `Boolean(document.querySelector(${JSON.stringify(selector)}))`
            ))
          ) {
            const zoom = contents.getZoomFactor();
            matches.push({
              x: Math.round(x + target.x * zoom),
              y: Math.round(y + target.y * zoom),
            });
          }
        }
        for (const child of view.children) await visit(child, x, y);
      };
      const window = BaseWindow.getAllWindows()[0];
      if (!window?.isVisible()) throw new Error("Native consent window is not visible");
      for (const child of window.contentView.children) await visit(child, 0, 0);
      if (matches.length !== 1)
        throw new Error(`Expected one visible native approval, found ${matches.length}`);
      return matches[0]!;
    }, target);
  }).toPass({ timeout: 10_000 });
  // Observe actual OS pointer delivery to this button before sending consent input.
  await moveWindowPointerThroughNativeInput(app, point);
  await expect.poll(() => button.evaluate((element) => element.matches(":hover"))).toBe(true);
  const nativeCapture = await app.app.evaluate(async ({ desktopCapturer, screen }) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: display.size,
    });
    const source = sources.find((source) => source.display_id === String(display.id)) ?? sources[0];
    if (!source) throw new Error("Owned native display capture is unavailable");
    return source.thumbnail.toPNG().toString("base64");
  });
  await test.info().attach("native-consent", {
    body: Buffer.from(nativeCapture, "base64"),
    contentType: "image/png",
  });
  await test.info().attach("native-consent-point", {
    body: JSON.stringify({ point, target }),
    contentType: "application/json",
  });
  await clickWindowPointThroughNativeInput(app, point);
}
