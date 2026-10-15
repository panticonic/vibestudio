/** Runs inside Electron's main process; self-contained for app.evaluate serialization. */
export async function inspectPresentedDesktopDocuments({ BaseWindow, BrowserWindow }, request) {
  const candidates = new Map();
  const ready = (contents) =>
    !contents.isDestroyed() && !contents.isLoadingMainFrame() && Boolean(contents.getURL());
  const windows = new Set([
    ...BaseWindow.getAllWindows(),
    ...(BrowserWindow?.getAllWindows() ?? []),
  ]);
  for (const window of windows) {
    const visibleWindow = () => !window.isDestroyed() && window.isVisible();
    if (!visibleWindow()) continue;
    const add = (contents, presented) => {
      if (contents && ready(contents) && !candidates.has(contents.id)) {
        candidates.set(contents.id, { contents, presented });
      }
    };
    // BrowserWindow owns a document directly; BaseWindow presents attached views.
    add(window.webContents, visibleWindow);
    const visit = (parent, presented) => {
      for (const view of parent.children ?? []) {
        const visibleView = () => {
          if (!presented() || !parent.children.includes(view) || !view.getVisible()) return false;
          const bounds = view.getBounds();
          return bounds.width > 0 && bounds.height > 0;
        };
        if (!visibleView()) continue;
        add(view.webContents, visibleView);
        visit(view, visibleView);
      }
    };
    visit(window.contentView, visibleWindow);
  }

  if (request.kind === "documents")
    return [...candidates.values()]
      .filter(({ contents, presented }) => presented() && ready(contents))
      .map(({ contents }) => ({ id: contents.id, url: contents.getURL() }));

  // Serialized once into the presented renderer for both observation and action.
  // The static bootstrap marker alone is not a pending review.
  const launchGate = (expectedHtml) => {
    const card = document.querySelector(
      'main[data-bootstrap-mode="approval"] #approvals .approval[role="group"][aria-labelledby="launch-gate-title"]'
    );
    if (
      !card ||
      card.querySelector("#launch-gate-title")?.textContent !== "Start this workspace?" ||
      !card.querySelector("#launch-gate-summary")?.textContent?.trim()
    )
      return null;
    const button = card.querySelector("button.primary");
    const review = {
      html: card.outerHTML,
      actionable:
        button instanceof HTMLButtonElement &&
        !button.disabled &&
        button.textContent?.trim() === "Start",
    };
    if (expectedHtml !== undefined) {
      if (!review.actionable || review.html !== expectedHtml) return { ...review, clicked: false };
      button.click();
      return { ...review, clicked: true };
    }
    return review;
  };

  const pairingConfirmation = (expected) => {
    const card = [
      ...document.querySelectorAll(
        'main[data-bootstrap-mode="connection"] #approvals .connection-option.connection-form'
      ),
    ].find((item) => item.querySelector(".title")?.textContent === "Connect to this server?");
    if (!card) return null;
    const endpointId = card
      .querySelector("code")
      ?.textContent?.replaceAll(":", "")
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(endpointId ?? "")) return null;
    const button = card.querySelector("button.primary");
    const review = {
      html: card.outerHTML,
      endpointId,
      actionable:
        button instanceof HTMLButtonElement &&
        !button.disabled &&
        button.textContent?.trim() === "Trust and connect",
    };
    if (expected) {
      if (
        !review.actionable ||
        review.html !== expected.html ||
        review.endpointId !== expected.endpointId
      )
        return { ...review, clicked: false };
      button.click();
      return { ...review, clicked: true };
    }
    return review;
  };

  const read = async ({ contents, presented }, script) => {
    if (!presented() || !ready(contents)) return undefined;
    const url = contents.getURL();
    let navigated = false;
    const onNavigation = (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) navigated = true;
    };
    contents.on("did-start-navigation", onNavigation);
    try {
      return await contents.executeJavaScript(script, true);
    } catch (error) {
      // Only an actual document lifecycle transition invalidates its original read.
      if (
        contents.isDestroyed() ||
        navigated ||
        contents.isLoadingMainFrame() ||
        contents.getURL() !== url
      )
        return undefined;
      throw error;
    } finally {
      contents.removeListener("did-start-navigation", onNavigation);
    }
  };

  if (request.kind === "start-launch-gate" || request.kind === "confirm-pairing") {
    const candidate = candidates.get(request.id);
    if (!candidate || candidate.contents.getURL() !== request.url) return false;
    const expression =
      request.kind === "start-launch-gate"
        ? `(${launchGate.toString()})(${JSON.stringify(request.html)})`
        : `(${pairingConfirmation.toString()})(${JSON.stringify({ html: request.html, endpointId: request.endpointId })})`;
    const result = await read(candidate, expression);
    return result?.clicked === true;
  }

  if (request.kind === "snapshots") {
    const snapshots = [];
    for (const candidate of candidates.values()) {
      const dom = await read(
        candidate,
        `(() => {
        const text = document.body?.innerText ?? "";
        const buttons = Array.from(document.querySelectorAll("button"))
          .map((button) => button.textContent?.trim() ?? "").filter(Boolean);
        const launchGateReview = (${launchGate.toString()})();
        const hasLaunchGateApproval = Boolean(launchGateReview);
        const pairingReview = (${pairingConfirmation.toString()})();
        const hasHostedShellChrome = Boolean(
          document.querySelector('[data-shell-top-chrome="titlebar"]')
          || document.querySelector(".titlebar-breadcrumb-scroll")
          || document.querySelector('[aria-label="Menu"]')
          || document.querySelector('[data-hosted-shell="true"]'));
        return {text: text.slice(0, 3000), buttons, hasLaunchGateApproval, launchGateReview, pairingReview, hasHostedShellChrome};
      })()`
      );
      if (dom !== undefined) {
        snapshots.push({
          id: candidate.contents.id,
          url: candidate.contents.getURL(),
          title: candidate.contents.getTitle(),
          ...dom,
        });
      }
    }
    return snapshots;
  }
  if (request.kind !== "click") throw new Error("Unknown presented desktop action");
  const ordered = [];
  for (const candidate of candidates.values()) {
    const priority = await read(
      candidate,
      `(() => {
      if ((${launchGate.toString()})()) return 0;
      if (document.querySelector('[data-shell-top-chrome="titlebar"]')
        || document.querySelector(".titlebar-breadcrumb-scroll")
        || document.querySelector('[aria-label="Menu"]')) return 2;
      return 3;
    })()`
    );
    if (priority !== undefined) ordered.push({ candidate, priority });
  }
  ordered.sort((a, b) => a.priority - b.priority);
  for (const { candidate } of ordered) {
    const clicked = await read(
      candidate,
      `(() => {
      const label = new RegExp(${JSON.stringify(request.labelSource)}, "i");
      const button = Array.from(document.querySelectorAll("button"))
        .find((item) => item.getClientRects().length > 0 && !item.closest('[hidden]') && label.test(
          item.getAttribute("aria-label")?.trim() || item.textContent?.trim() || ""));
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`
    );
    if (clicked) return true;
  }
  return false;
}
