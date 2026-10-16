import type { WebContents } from "electron";
import type { ClientWindow } from "./clientWindow.js";
import type { WindowTextPort } from "./testApiDevice.js";

/**
 * The Electron half of the desktop device driver: reading a client window's
 * visible text, learning when it may have changed, and typing into it.
 *
 * Change is observed where it happens. The injected observer reports DOM
 * mutations as a console message the host already receives, and a navigation
 * (a swap to a new build) is reported by the page's own load events, so a
 * waiter sleeps until the page says something happened.
 */

const CHANGED = "__vibestudio_text_changed__";

const OBSERVER = `(() => {
  if (window.__vibestudioTextWatch) return;
  window.__vibestudioTextWatch = true;
  let queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; console.info(${JSON.stringify(CHANGED)}); });
  };
  new MutationObserver(notify).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
  });
  notify();
})()`;

interface Watch {
  listeners: Set<() => void>;
}

function contentsOf(window: ClientWindow): WebContents {
  const contents = window.contents();
  if (!contents)
    throw Object.assign(new Error(`Window ${window.windowId} has no page`), { code: "ECLOSED" });
  return contents;
}

/** Special keys a test sends as terminal-style control characters. */
const NAMED_KEYS: Record<string, string> = {
  "\r": "Enter",
  "\n": "Enter",
  "\t": "Tab",
  "\x1b": "Escape",
  "\x7f": "Backspace",
};

export function createElectronWindowText(): WindowTextPort {
  const watches = new WeakMap<WebContents, Watch>();

  const watchOf = (contents: WebContents): Watch => {
    const existing = watches.get(contents);
    if (existing) return existing;
    const watch: Watch = { listeners: new Set() };
    watches.set(contents, watch);
    const fire = () => {
      for (const listener of [...watch.listeners]) listener();
    };
    const inject = () => {
      if (!contents.isDestroyed())
        void contents.executeJavaScript(OBSERVER, true).catch(() => undefined);
    };
    contents.on("console-message", (event) => {
      if (event.message === CHANGED) fire();
    });
    // A new document has none of the observer: install it, and report the load itself.
    contents.on("dom-ready", () => {
      inject();
      fire();
    });
    contents.on("did-finish-load", fire);
    contents.on("did-navigate-in-page", fire);
    contents.on("page-title-updated", fire);
    inject();
    return watch;
  };

  return {
    async read(window) {
      const contents = contentsOf(window);
      watchOf(contents);
      return (await contents.executeJavaScript(
        "document.body ? document.body.innerText : ''",
        true
      )) as string;
    },

    changed(window, signal) {
      const watch = watchOf(contentsOf(window));
      let fired = false;
      let wake: (() => void) | null = null;
      const listener = () => {
        fired = true;
        wake?.();
      };
      watch.listeners.add(listener);
      return {
        wait: () =>
          new Promise<void>((resolve, reject) => {
            const reason = () =>
              signal.reason instanceof Error
                ? signal.reason
                : new Error("The operation was cancelled");
            if (signal.aborted) return reject(reason());
            if (fired) return resolve();
            const onAbort = () => reject(reason());
            wake = () => {
              signal.removeEventListener("abort", onAbort);
              resolve();
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        dispose: () => {
          watch.listeners.delete(listener);
        },
      };
    },

    async type(window, keys) {
      const contents = contentsOf(window);
      contents.focus();
      for (const character of keys) {
        const named = NAMED_KEYS[character];
        if (named) {
          contents.sendInputEvent({ type: "keyDown", keyCode: named });
          contents.sendInputEvent({ type: "keyUp", keyCode: named });
        } else {
          contents.sendInputEvent({ type: "keyDown", keyCode: character });
          contents.sendInputEvent({ type: "char", keyCode: character });
          contents.sendInputEvent({ type: "keyUp", keyCode: character });
        }
      }
    },
  };
}
