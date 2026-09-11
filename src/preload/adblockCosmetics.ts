/**
 * The page half of cosmetic ad filtering.
 *
 * Network blocking cancels requests from the main process and needs nothing
 * from the page. Cosmetic filtering cannot work that way: which rules apply
 * depends on the classes, ids and link targets actually present in this
 * document, so the engine has to be told what is there. The main process
 * registered handlers for exactly that and nothing ever called them, so no
 * element was ever hidden and no scriptlet ever ran — the "Elements hidden"
 * counter in the ad-block settings was structurally stuck at zero.
 *
 * This side only reports. The main process owns the engine, decides what to
 * hide, and injects the stylesheet and scriptlets itself, because the page is
 * the least trustworthy participant in the exchange and must not be handed the
 * filter set to apply at its discretion.
 */

import { ipcRenderer } from "electron";
import { DOMMonitor, extractFeaturesFromDOM } from "@ghostery/adblocker-content";

const IPC_INJECT_COSMETICS = "vibestudio:adblock:inject-cosmetics";
const IPC_MUTATION_OBSERVER = "vibestudio:adblock:mutation-observer-enabled";

/** Documents that can carry ads. Anything else is our own surface or empty. */
function isFilterableDocument(): boolean {
  const protocol = window.location.protocol;
  return protocol === "http:" || protocol === "https:";
}

export function installAdBlockCosmetics(): void {
  if (!isFilterableDocument()) return;

  // A failure here must never break the page: the worst outcome of a dropped
  // report is an ad that stays visible.
  const report = (update?: Parameters<typeof reportFeatures>[0]): void => {
    void ipcRenderer.invoke(IPC_INJECT_COSMETICS, window.location.href, update).catch(() => {});
  };
  function reportFeatures(update: {
    classes: string[];
    hrefs: string[];
    ids: string[];
    lifecycle: "start" | "dom-update";
  }): void {
    report(update);
  }

  // The first report carries no features on purpose: it asks for the rules that
  // depend only on the address — base rules, hostname rules and scriptlets —
  // and it runs before the document exists so that hiding takes effect without
  // the ad being painted first.
  report();

  const reportDocument = (lifecycle: "start" | "dom-update"): void => {
    const { classes, hrefs, ids } = extractFeaturesFromDOM([document.documentElement]);
    reportFeatures({ classes, hrefs, ids, lifecycle });
  };

  const start = async (): Promise<void> => {
    reportDocument("start");
    const watchMutations = await ipcRenderer
      .invoke(IPC_MUTATION_OBSERVER)
      .catch(() => false as boolean);
    if (watchMutations !== true) return;
    // Ads arrive after load as often as with it, so the features found once are
    // not the features this page will have. Report only what each batch adds:
    // the monitor tracks what it has already seen, and the engine answers with
    // the rules for the new features alone.
    const monitor = new DOMMonitor((update) => {
      if (update.type === "features") {
        reportFeatures({
          classes: update.classes,
          hrefs: update.hrefs,
          ids: update.ids,
          lifecycle: "dom-update",
        });
        return;
      }
      const { classes, hrefs, ids } = extractFeaturesFromDOM(update.elements);
      if (classes.length === 0 && hrefs.length === 0 && ids.length === 0) return;
      reportFeatures({ classes, hrefs, ids, lifecycle: "dom-update" });
    });
    monitor.start(window);
    window.addEventListener("pagehide", () => monitor.stop(), { once: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void start(), { once: true });
  } else {
    void start();
  }
}
