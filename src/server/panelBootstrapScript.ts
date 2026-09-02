/**
 * Panel bootstrap script — host-injected panel identity bootstrap.
 *
 * This script is served as `__loader.js` under each panel route and injected
 * into panel HTML as a blocking classic script. The host injects the full
 * panel init bundle at runtime, and this loader simply normalizes it into the
 * globals consumed by the transport/runtime code.
 */

export const PANEL_BOOTSTRAP_SCRIPT = `(async () => {
  const bootStartedAt = Date.now();
  const reportBoot = (phase, error, failureStage) => {
    const previous = globalThis.__vibestudioPanelBoot;
    // Ready is boot-terminal. A later error/unhandledrejection is an
    // application-runtime event, not a boot outcome; letting it overwrite the
    // held record would poison host relays and post-restart re-adoption.
    if (previous?.phase === "ready" && phase === "failed") return previous;
    const next = {
      phase,
      // The loader is the only place that can tell an incomplete host config
      // from a bundle that failed to load from entry code that threw; tag the
      // record so the coordinator preserves the distinction.
      ...(phase === "failed" && failureStage ? { failureStage } : {}),
      startedAt: previous?.startedAt ?? bootStartedAt,
      updatedAt: Date.now(),
      runtimeEntityId: globalThis.__vibestudioEntityId ?? previous?.runtimeEntityId ?? null,
      source: globalThis.__vibestudioSourceRepo ?? previous?.source ?? null,
      contextId: globalThis.__vibestudioContextId ?? previous?.contextId ?? null,
      effectiveVersion:
        globalThis.__vibestudioEffectiveVersion ?? previous?.effectiveVersion ?? null,
      buildKey: globalThis.__vibestudioBuildKey ?? previous?.buildKey ?? null,
      ...(error
        ? {
            error: {
              name: String(error?.name || "Error"),
              message: String(error?.message || error),
              stack: typeof error?.stack === "string" ? error.stack.slice(0, 12000) : undefined,
            },
          }
        : {}),
    };
    globalThis.__vibestudioPanelBoot = next;
    globalThis.dispatchEvent(
      new CustomEvent("vibestudio:panel-boot", { detail: next })
    );
    return next;
  };
  // The generated entry graph owns the successful terminal transition. A
  // module script's load event is a browser resource signal, not proof that
  // the framework adapter reached its mount boundary.
  globalThis.__vibestudioPanelMarkReady = () => reportBoot("ready");
  reportBoot("loading");
  globalThis.addEventListener("error", (event) => {
    reportBoot("failed", event.error || new Error(event.message || "Panel entry failed"), "entry");
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    reportBoot("failed", event.reason || new Error("Unhandled panel rejection"), "entry");
  });

  // Capture the loader <script> element synchronously: document.currentScript
  // is null after the first await below, so read its data-bundle-src (the
  // content-hashed entry bundle name) up front.
  const loaderScript = document.currentScript;
  const configuredBundleSrc =
    loaderScript && loaderScript instanceof HTMLScriptElement
      ? loaderScript.dataset.bundleSrc
      : null;
  const loaderScriptUrl =
    loaderScript && loaderScript instanceof HTMLScriptElement ? loaderScript.src : null;
  const installRandomUuidPolyfill = () => {
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj || typeof cryptoObj.randomUUID === "function") return;
    const fallbackRandom = () => Math.floor(Math.random() * 256);
    const getByte = () => {
      if (typeof cryptoObj.getRandomValues === "function") {
        const bytes = new Uint8Array(1);
        cryptoObj.getRandomValues(bytes);
        return bytes[0];
      }
      return fallbackRandom();
    };
    Object.defineProperty(cryptoObj, "randomUUID", {
      configurable: true,
      value: () => {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < bytes.length; i++) bytes[i] = getByte();
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
        return [
          hex.slice(0, 4).join(""),
          hex.slice(4, 6).join(""),
          hex.slice(6, 8).join(""),
          hex.slice(8, 10).join(""),
          hex.slice(10, 16).join(""),
        ].join("-");
      },
    });
  };
  installRandomUuidPolyfill();

  const storageKey = () => "__vibestudioPanelInit:" + location.href;
  const parseStoredInit = () => {
    try {
      const raw = sessionStorage.getItem(storageKey());
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const persistPanelInit = (value) => {
    try {
      const stored = value && typeof value === "object" ? { ...value } : value;
      if (stored && typeof stored === "object") {
        delete stored.connectionId;
      }
      sessionStorage.setItem(storageKey(), JSON.stringify(stored));
    } catch {
      /* ignore */
    }
  };

  let cfg = null;
  const shell = globalThis.__vibestudioShell;

  if (shell && typeof shell.getPanelInit === "function") {
    try {
      cfg = await shell.getPanelInit();
      persistPanelInit(cfg);
    } catch (err) {
      reportBoot("failed", err, "config");
      const root = document.getElementById("root");
      if (root) root.textContent = "Failed to load panel init: " + (err.message || err);
      return;
    }
  } else if (globalThis.__vibestudioPanelInit) {
    cfg = globalThis.__vibestudioPanelInit;
    persistPanelInit(cfg);
  } else {
    cfg = parseStoredInit();
  }

  const entityId = cfg?.entityId;
  const slotId = cfg?.slotId ?? entityId;
  const url = new URL(location.href);
  const connectionId = typeof cfg?.connectionId === "string" ? cfg.connectionId : undefined;

  if (!cfg || !entityId || !cfg.gatewayConfig || !cfg.gatewayConfig.serverUrl || !cfg.gatewayConfig.token) {
    reportBoot("failed", new Error("Panel bootstrap configuration is incomplete"), "config");
    const root = document.getElementById("root");
    if (root) root.innerHTML = "<p>Open this panel from Vibestudio.</p>";
    return;
  }

  globalThis.__vibestudioEntityId = entityId;
  globalThis.__vibestudioSlotId = slotId;
  const gatewayConfig = cfg.gatewayConfig;
  // Panel RPC rides the shell bridge (host → Iroh control channel), not a
  // direct /rpc WebSocket: no panel-side ws URL is built. The token still
  // arrives out-of-band here and is consumed by the bridge's SessionNegotiation.
  globalThis.__vibestudioGatewayToken = gatewayConfig.token;
  globalThis.__vibestudioKind = "panel";

  let effectiveStateArgs = cfg.stateArgs;
  if (url.searchParams.has("stateArgs")) {
    try { effectiveStateArgs = JSON.parse(url.searchParams.get("stateArgs")); } catch { /* ignore */ }
  }
  Object.assign(globalThis, {
    __vibestudioContextId: cfg.contextId,
    __vibestudioParentId: cfg.parentId,
    __vibestudioParentEntityId: cfg.parentEntityId,
    __vibestudioInitialTheme: cfg.theme,
    __vibestudioGatewayConfig: gatewayConfig,
    __vibestudioSourceRepo: cfg.sourceRepo,
    __vibestudioEffectiveVersion: cfg.effectiveVersion ?? cfg.env?.__VIBESTUDIO_EFFECTIVE_VERSION ?? null,
    __vibestudioBuildKey: cfg.buildKey ?? cfg.env?.__VIBESTUDIO_BUILD_KEY ?? null,
    __vibestudioEnv: cfg.env,
    __vibestudioStateArgs: effectiveStateArgs,
    __vibestudioConnectionId: connectionId,
    __vibestudioClientLabel: cfg.clientLabel,
    process: { env: cfg.env },
  });
  reportBoot("booting");

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const loaderUrl = new URL(loaderScriptUrl || document.baseURI || location.href);
    const transportUrl = new URL("__transport.js", loaderUrl);
    // The loader and transport are one content-addressed runtime set. Preserve
    // the loader's exact version query so both share one immutable identity.
    transportUrl.search = loaderUrl.search;
    s.src = transportUrl.href;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  delete globalThis.__vibestudioConnectionId;

  // A headless host's fallback shell owns an asynchronous authenticated
  // WebSocket. Do not start (and eventually mark ready) the panel bundle until
  // that panel endpoint is actually routable. Desktop/mobile bridges are
  // already host-owned and need not expose this readiness hook.
  if (typeof globalThis.__vibestudioShell?.ready === "function") {
    await globalThis.__vibestudioShell.ready();
  }

  globalThis.__vibestudioContextReady = true;
  const bundle = document.createElement("script");
  bundle.type = "module";
  bundle.src = configuredBundleSrc || "./bundle.js";
  bundle.onerror = () => {
    reportBoot("failed", new Error("The panel bundle could not be loaded"), "bundle-load");
    const root = document.getElementById("root");
    if (!root || root.childElementCount > 0) return;
    root.innerHTML =
      '<main style="font:14px system-ui;padding:24px;max-width:720px;margin:auto">' +
      '<h1>Panel failed to start</h1><p>The panel bundle could not be loaded.</p>' +
      '<button type="button" onclick="location.reload()">Reload panel</button></main>';
  };
  document.body.appendChild(bundle);
})();`;
