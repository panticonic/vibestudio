/**
 * Vibestudio callback relay — OAuth profile (dumb, ephemeral landing +
 * universal-link host). Plan §7.
 *
 * The relay is deliberately harmless here: PKCE keeps the `codeVerifier` on the
 * home server, so even on the desktop path where the relay sees the `code`, the
 * code is useless to the relay. `state` is the CSRF token — relayed VERBATIM,
 * never re-signed. Lookup is by the explicit `transactionId` carried through the
 * landing URL (NOT a state-scan).
 *
 * EXACTLY ONE path per platform, and each fails loud:
 *   - mobile  -> deep-link. The relay only HOSTS the Apple App Site Association
 *     / Android assetlinks (see build* below). When that works the OS hands the
 *     URL straight into the already-connected app, which forwards {state,code}
 *     over the Iroh pipe — this landing HTML never runs. If we DO reach this
 *     handler for a mobile transaction the deep-link failed (app missing /
 *     association broken): we render an error and refuse to forward. We never
 *     fall back to the desktop backhaul — a silent second path is exactly what
 *     the fail-loud rule forbids.
 *   - desktop -> backhaul-forward. Push {state,code} down the owning server's
 *     persistent backhaul. If that backhaul is down, fail loud (the user
 *     retries); there is no buffering.
 */

export type OAuthPlatform = "mobile" | "desktop";

export interface OAuthRegistration {
  platform: OAuthPlatform;
  serverId: string;
  expiresAt: number;
}

export interface OAuthLandingDeps {
  /** Resolve a registered transaction (expiry-checked) by explicit id. */
  lookup: (transactionId: string) => OAuthRegistration | undefined;
  /** Single-use: drop the transaction after a desktop handoff. */
  consume: (transactionId: string) => void;
  /** Send a frame down the owning server's backhaul; false if none connected. */
  deliverToBackhaul: (serverId: string, frame: unknown) => boolean;
}

/**
 * The transactionId is carried in the path (`/oauth/callback/<transactionId>`,
 * which the App-Links / App-Site-Association `*` component matches so the OS
 * can deep-link), with `?transactionId=` accepted as a fallback for IdPs that
 * drop redirect-URI path segments.
 */
function parseTransactionId(url: URL): string | undefined {
  const prefix = "/oauth/callback/";
  if (url.pathname.startsWith(prefix)) {
    const segment = url.pathname.slice(prefix.length).split("/")[0];
    if (segment) {
      // A malformed %-escape (e.g. a lone "%") must NOT throw a URIError that
      // surfaces as a 500 — fail closed as a missing tx (clean 400).
      return safeDecodeURIComponent(segment) ?? undefined;
    }
  }
  return url.searchParams.get("transactionId") ?? undefined;
}

/** decodeURIComponent that returns null on a malformed sequence rather than
 * throwing a URIError. Mirrors the same guard in ./registry. */
function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function handleOAuthLanding(url: URL, now: number, deps: OAuthLandingDeps): Response {
  const transactionId = parseTransactionId(url);
  const code = url.searchParams.get("code") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;
  const errorDescription = url.searchParams.get("error_description") ?? undefined;

  if (!transactionId) {
    return htmlError(400, "Invalid callback", "This OAuth callback is missing its transaction id.");
  }

  const registration = deps.lookup(transactionId);
  if (!registration || now > registration.expiresAt) {
    // Unknown or expired transaction — fail loud (covers replayed / stale links).
    return htmlError(
      404,
      "Unknown sign-in",
      "This sign-in link is unknown or has expired. Start the connection again from Vibestudio."
    );
  }

  if (registration.platform === "mobile") {
    // Reaching the landing HTML means the OS deep-link did not fire. Refuse to
    // forward — the mobile path is the app forwarding over the pipe, not the
    // relay backhaul. (Fail loud, no silent second path.) A non-200 so monitoring
    // sees the failed deep-link instead of a "success" hit.
    return htmlError(
      404,
      "Open the Vibestudio app",
      "This sign-in should have opened the Vibestudio app automatically. Make sure the app is installed, then start the connection again."
    );
  }

  // desktop: forward {state, code, error} verbatim down the owning server's
  // backhaul. We forward even a provider error so the server can fail the pending
  // transaction promptly rather than waiting for it to time out.
  const delivered = deps.deliverToBackhaul(registration.serverId, {
    t: "oauth-callback",
    transactionId,
    state,
    code,
    error,
  });
  if (!delivered) {
    return htmlError(
      503,
      "Server offline",
      "Could not reach your Vibestudio server to finish signing in. Make sure it is running, then start the connection again."
    );
  }
  deps.consume(transactionId);
  if (error) {
    // The provider itself rejected the sign-in (consent denied, invalid client,
    // …). Reflect reality with a non-200 that surfaces the provider's own message
    // instead of a misleading "Sign-in complete."
    return htmlError(
      400,
      "Sign-in failed",
      errorDescription
        ? `The sign-in provider reported an error: ${error} — ${errorDescription}`
        : `The sign-in provider reported an error: ${error}`
    );
  }
  return htmlPage(200, "Sign-in complete", "You can close this window and return to Vibestudio.");
}

// ---- Pair-link landing -----------------------------------------------------

/**
 * HTTPS carrier for pairing QR codes (`https://vibestudio.app/p#...`).
 *
 * The private pairing material lives in the URL fragment, so it is never sent
 * to this Worker. The page reconstructs the native `vibestudio://connect/...`
 * URL client-side and opens the installed app. Desktop browsers show the custom
 * compact path for copy/retry; Android uses an intent URL for a better install/open
 * handoff.
 */
export function handlePairLanding(url: URL): Response {
  if (url.pathname !== "/p")
    return htmlError(404, "Not found", "This Vibestudio page does not exist.");
  return new Response(PAIR_LANDING_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

const CONNECTION_PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f6f2ea;--panel:#fffdf8;--ink:#14243d;--muted:#56627a;--line:#e0d8c9;--primary:#204fa3;--on-primary:#fff;--link:#204fa3}
*{box-sizing:border-box}body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:clamp(24px,8vw,80px) 24px;background:var(--bg);color:var(--ink)}main{max-width:600px;margin:0 auto;padding:clamp(24px,5vw,48px);border:1px solid var(--line);border-top:4px solid var(--primary);border-radius:4px;background:var(--panel)}main:before{content:"";display:block;width:32px;height:40px;margin-bottom:24px;background:url('/brand/vibestudio-symbol.svg') center/contain no-repeat}h1{font-size:28px;line-height:1.2;letter-spacing:-.035em;font-weight:650;margin:0 0 20px}p{margin:16px 0}button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;border:0;border-radius:4px;background:var(--primary);color:var(--on-primary);font:600 14px system-ui;text-decoration:none;cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible,a:focus-visible{outline:3px solid var(--link);outline-offset:4px}code{overflow-wrap:anywhere;font-size:12px}a{color:var(--link)}.muted{color:var(--muted);font-size:14px}
@media(prefers-color-scheme:dark){:root{--bg:#1a202a;--panel:#242e3c;--ink:#f4f5f6;--muted:#c7cdd5;--line:#485667;--primary:#496fa8;--on-primary:#fff;--link:#afc8f0}main:before{background-image:url('/brand/vibestudio-symbol-dark.svg')}}
`;

export function handleApexLanding(): Response {
  return new Response(APEX_LANDING_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

const APEX_LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#F6F2EA" media="(prefers-color-scheme: light)" data-scheme="light">
  <meta name="theme-color" content="#1A202A" media="(prefers-color-scheme: dark)" data-scheme="dark">
  <meta name="description" content="Vibestudio is an open-source browser for apps with agents inside them. Build your own, or open other people's and run them on your own models, with your approval.">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <title>Vibestudio — build and share deeply AI-infused apps</title>
  <script>
    (() => {
      const root = document.documentElement;
      const system = matchMedia("(prefers-color-scheme: dark)");
      const valid = (theme) => (theme === "light" || theme === "dark" ? theme : null);
      const params = new URLSearchParams(location.search);
      let chosen = valid(params.get("theme"));
      if (chosen) {
        try { localStorage.setItem("theme", chosen); } catch {}
        params.delete("theme");
        history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
      } else {
        try { chosen = valid(localStorage.getItem("theme")); } catch {}
      }
      const apply = () => {
        if (chosen) root.dataset.theme = chosen; else delete root.dataset.theme;
        for (const element of document.querySelectorAll("[data-scheme]")) {
          const scheme = element.dataset.scheme;
          element.media = chosen ? (chosen === scheme ? "all" : "not all") : "(prefers-color-scheme: " + scheme + ")";
        }
        for (const link of document.querySelectorAll("a[data-carry-theme]")) {
          const url = new URL(link.href);
          if (chosen) url.searchParams.set("theme", chosen); else url.searchParams.delete("theme");
          link.href = url.href;
        }
        const toggle = document.getElementById("theme-toggle");
        if (toggle) toggle.setAttribute("aria-pressed", String((chosen ?? (system.matches ? "dark" : "light")) === "dark"));
      };
      apply();
      system.addEventListener("change", apply);
      document.addEventListener("DOMContentLoaded", () => {
        apply();
        document.getElementById("theme-toggle").addEventListener("click", () => {
          const dark = (chosen ?? (system.matches ? "dark" : "light")) === "dark";
          chosen = dark ? "light" : "dark";
          try { localStorage.setItem("theme", chosen); } catch {}
          apply();
        });
      });
    })();
  </script>
  <style>
    :root{color-scheme:light dark;--bg:light-dark(#f6f2ea,#1a202a);--paper:light-dark(#fffdf8,#222a36);--ink:light-dark(#14243d,#f1eee8);--muted:light-dark(#56627a,#b8c0cb);--line:light-dark(#e0d8c9,#36414f);--primary:light-dark(#204fa3,#496fa8);--primary-hover:light-dark(#183e83,#5a7fb8);--on-primary:#fff;--link:light-dark(#204fa3,#afc8f0);--signal:light-dark(#c73f2d,#e8a08f);--signal-soft:light-dark(#f7ded6,#3d2c2f);--tint:light-dark(#e6edf8,#232f42);--accent-a:light-dark(#204fa3,#8fb0e8);--accent-b:light-dark(#c73f2d,#e8a08f);--shadow:0 30px 80px -30px light-dark(#14243d59,#000c);--shadow-sm:0 14px 34px -18px light-dark(#14243d40,#0009);--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}:root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}
    *{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.65 var(--sans);-webkit-font-smoothing:antialiased}a{color:var(--link);text-underline-offset:3px}button,input,textarea{font:inherit}button,a{-webkit-tap-highlight-color:transparent}a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid var(--link);outline-offset:4px}button:disabled{cursor:default;opacity:.65}[hidden]{display:none!important}img{max-width:100%}main{overflow-x:clip}
    .wrap{width:min(1120px,calc(100% - 64px));margin-inline:auto}.narrow{width:min(680px,calc(100% - 64px));margin-inline:auto}
    .topbar{height:84px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:flex;align-items:center;gap:10px;font-size:21px;font-weight:750;letter-spacing:-.04em;text-decoration:none;color:var(--ink)}.brand-mark{display:block;width:24px;height:32px}.brand-mark img{display:block;width:100%;height:100%;object-fit:contain}.nav{display:flex;align-items:center;gap:28px;font-size:15px;font-weight:600}.nav a{text-decoration:none;color:var(--link)}.nav a:hover{text-decoration:underline}.theme-toggle{display:grid;place-items:center;width:38px;height:38px;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--paper);color:var(--ink);cursor:pointer;transition:border-color .15s}.theme-toggle:hover{border-color:var(--primary)}.theme-toggle svg{width:18px;height:18px}
    h1,h2,h3{font-weight:750;letter-spacing:-.035em}
    .kicker{display:block;margin:0 0 14px;font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--signal)}
    .hero{padding-block:48px 0;text-align:center}
    .eyebrow{display:inline-flex;align-items:center;gap:10px;margin:0 0 28px;padding:6px 16px 6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--paper);font-size:13px;font-weight:600;color:var(--muted)}.eyebrow i{width:8px;height:8px;border-radius:50%;background:var(--signal);box-shadow:0 0 0 4px var(--signal-soft)}
    h1{font-size:clamp(44px,7vw,92px);line-height:.98;letter-spacing:-.05em;margin:0 auto 28px;max-width:14ch;text-wrap:balance}.accent{white-space:nowrap;background:linear-gradient(100deg,var(--accent-a) 10%,var(--accent-b) 90%);-webkit-background-clip:text;background-clip:text;color:transparent}.lede{font-size:20px;line-height:1.6;color:var(--muted);max-width:36em;margin:0 auto}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}.hero .actions{justify-content:center}.button{display:inline-flex;justify-content:center;align-items:center;gap:10px;min-height:48px;padding:11px 24px;border:1px solid var(--line);border-radius:999px;font-size:15px;font-weight:650;white-space:nowrap;text-decoration:none;cursor:pointer;transition:transform .15s,box-shadow .15s,background .15s,border-color .15s}.button:hover{transform:translateY(-1px)}.primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary);box-shadow:0 10px 24px -10px var(--primary)}.primary:hover{background:var(--primary-hover);box-shadow:0 14px 28px -10px var(--primary)}.secondary{background:var(--paper);color:var(--ink)}.secondary:hover{border-color:var(--primary)}.fine{font-size:14px;color:var(--muted);margin:18px 0 0}
    .shot{position:relative;margin:56px auto 0;max-width:560px}.shot img{display:block;width:100%;height:auto;border-radius:12px;border:1px solid var(--line);box-shadow:var(--shadow);background:#1a202a}figcaption{font-size:14px;color:var(--muted);margin-top:16px;line-height:1.5}.shot figcaption{text-align:center}
    .section-title{font-size:clamp(32px,4.4vw,52px);line-height:1.05;margin:0 0 24px}
    .essay{padding-block:120px 48px}.essay p{font-size:19px;line-height:1.75;margin:0 0 22px}.essay .section-title+p{font-size:22px;line-height:1.6;font-weight:500}
    .watch{padding-block:16px 104px}.video{margin:0 auto;max-width:960px}.video iframe{display:block;width:100%;aspect-ratio:16/9;height:auto;border:0;border-radius:16px;box-shadow:var(--shadow);background:#1a202a}.video figcaption{text-align:center}
    .things{padding-block:24px 104px;display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:start}.features{margin:0;display:grid;gap:14px;counter-reset:feature}.features>div{position:relative;padding:22px 24px 22px 78px;border:1px solid var(--line);border-radius:16px;background:var(--paper);counter-increment:feature;transition:transform .2s,box-shadow .2s,border-color .2s}.features>div:before{content:counter(feature,decimal-leading-zero);position:absolute;left:22px;top:22px;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font:700 13px var(--mono);background:var(--tint);color:var(--link)}.features>div:nth-child(even):before{background:var(--signal-soft);color:var(--signal)}.features>div:hover{transform:translateY(-2px);box-shadow:var(--shadow-sm);border-color:color-mix(in srgb,var(--primary) 40%,var(--line))}.features dt{font-size:19px;font-weight:700;letter-spacing:-.02em;line-height:1.3;margin:6px 0 8px}.features dd{margin:0;color:var(--muted);font-size:16px}.things figure{margin:0;position:sticky;top:32px}.things figure img{display:block;width:100%;height:auto;border-radius:14px;border:1px solid var(--line);box-shadow:var(--shadow)}
    .try{padding:clamp(28px,5vw,56px);border-radius:28px;background:var(--tint)}.try-intro{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:end}.try-intro .section-title{margin:0}.try-intro p{margin:0;color:var(--muted)}.workspace-connect{display:flex;align-items:center;justify-content:space-between;gap:28px;margin-top:32px;padding:20px 24px;border:1px solid var(--line);border-radius:16px;background:var(--paper);box-shadow:var(--shadow-sm)}.workspace-connect p{margin:0;font-size:15px}#workspace-capabilities{color:var(--muted)}.workspace-connect button{flex-shrink:0}
    .install{padding-block:104px 72px;display:grid;grid-template-columns:1fr 1.2fr;gap:64px;align-items:start}.install-copy p{margin:0 0 16px;color:var(--muted)}.platforms{list-style:none;margin:0;padding:6px 26px;border:1px solid var(--line);border-radius:16px;background:var(--paper)}.platforms li{display:grid;grid-template-columns:140px 1fr;gap:20px;border-bottom:1px solid var(--line);padding:18px 0;font-size:15px}.platforms li:last-child{border-bottom:0}.platforms b{font-weight:700}.platforms span{color:var(--muted)}code{font:13px/1.6 var(--mono);overflow-wrap:anywhere;color:var(--ink)}.platforms code{padding:2px 7px;border-radius:6px;background:var(--tint);-webkit-box-decoration-break:clone;box-decoration-break:clone}
    .closing{padding-block:40px 104px}.closing p{font-size:19px;line-height:1.75;margin:0 0 18px}.closing .sig{font-weight:700;color:var(--signal)}
    footer{border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:24px;padding-block:24px 40px;font-size:14px;color:var(--muted)}.footer-links{display:flex;gap:24px}.footer-links a{text-decoration:none}
    .image-lab{--copper:#e8a08f;--cream:#f6f2ea;margin:40px 0 0;border:1px solid #3a4656;border-radius:14px;background:#18202b;color:var(--cream);overflow:hidden;box-shadow:0 22px 70px #14243d1f}.lab-top{padding:34px 36px 28px;background:radial-gradient(ellipse at 85% 0,#34465f 0,transparent 65%);border-bottom:1px solid #ffffff26;display:flex;justify-content:space-between;gap:24px}.lab-live{font:11px var(--mono);text-transform:uppercase;letter-spacing:.16em;color:var(--copper)}.lab-top h2{font:750 clamp(30px,4vw,44px)/1.1 var(--sans);letter-spacing:-.035em;margin:12px 0}.lab-top p{max-width:48ch;line-height:1.6;color:#c3cad4;margin:0}.lab-body{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.4fr)}.lab-controls{padding:28px;border-right:1px solid #ffffff26;min-width:0}.lab-controls label{display:block;font:600 15px var(--sans);margin-bottom:12px}.lab-controls textarea,.lab-controls input{box-sizing:border-box;width:100%;border:1px solid #55657a;border-radius:8px;background:#121820;color:var(--cream);padding:14px;font:15px/1.6 inherit;resize:vertical}.lab-ideas{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 24px}.lab-ideas button,.lab-secondary{border:1px solid #ffffff35;border-radius:30px;background:transparent;color:#f0bcae;min-height:38px;padding:8px 12px;font:12px var(--mono);cursor:pointer}.lab-ideas button:hover,.lab-secondary:hover{background:#ffffff12}.lab-submit{width:100%;background:var(--copper)!important;color:#241b28!important;border-color:var(--copper)!important;border-radius:8px!important;min-height:48px}.image-lab button:disabled{opacity:.55;cursor:wait}.image-lab :focus-visible{outline:3px solid #f0bcae;outline-offset:4px}.lab-note,.lab-status{font-size:12px;color:#c3cad4;line-height:1.6}.lab-status{min-height:3.2em;margin-top:16px}.lab-status[data-error="true"]{color:#ffb4a9}.lab-preview{min-width:0;min-height:520px;padding:22px;display:flex;flex-direction:column;align-items:stretch;justify-content:center;background:radial-gradient(ellipse at 50% 45%,#2f3d52 0,#1e2733 65%,#18202b 100%);position:relative}.lab-placeholder{text-align:center;padding:60px 12px;position:relative}.lab-orbit{width:160px;height:160px;margin:0 auto 32px;border:1px solid #e8a08f70;border-radius:50%;display:grid;place-items:center;position:relative;box-shadow:0 0 80px #e8a08f18,inset 0 0 50px #e8a08f0d}.lab-orbit:before,.lab-orbit:after{content:"";position:absolute;inset:20px -28px;border:1px solid #e8a08f80;border-radius:50%;transform:rotate(-38deg)}.lab-orbit:after{transform:rotate(38deg);inset:-28px 20px}.lab-orbit span{font:300 78px var(--sans);color:var(--copper)}.lab-placeholder h3{font:700 24px var(--sans);margin:0 0 12px}.lab-placeholder p{font-size:13px;color:#c3cad4;max-width:27ch;margin:auto;line-height:1.6}.lab-preview iframe{width:100%;height:530px;border:0;border-radius:10px;background:#fffdf8}.lab-preview>p{text-align:center;color:#c3cad4;font-size:12px;margin:18px 0 8px}.lab-download{align-self:center;font:12px var(--mono);color:var(--copper);padding:8px}.lab-bottom{border-top:1px solid #ffffff26;padding:18px 28px;display:flex;gap:16px;align-items:center;justify-content:space-between}.lab-bottom p{font:10px/1.6 var(--mono);color:#aeb7c3;overflow-wrap:anywhere;margin:0}.lab-transcript{list-style:none;padding:0;margin:16px 0;max-height:220px;overflow:auto}.lab-transcript li{padding:12px 0;border-top:1px solid #ffffff20}.lab-transcript strong{font:10px var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--copper)}.lab-transcript p{font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.lab-revision-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.lab-working-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#e8a08f;margin-right:8px}.image-lab[data-working="true"] .lab-working-dot{animation:lab-pulse 1.6s ease-in-out infinite}@keyframes lab-pulse{50%{opacity:.2;box-shadow:0 0 0 5px #e8a08f25}}@media(max-width:800px){.lab-body{grid-template-columns:1fr}.lab-controls{border-right:0;border-bottom:1px solid #ffffff26}.lab-preview{min-height:430px}.lab-preview iframe{height:480px}}@media(max-width:560px){.lab-top{padding:24px;gap:12px}.lab-controls{padding:22px}.lab-preview{padding:12px}.lab-bottom{padding:16px 22px}.lab-top h2{font-size:34px}}@media(prefers-reduced-motion:reduce){.lab-working-dot{animation:none!important}}
.lab-machine{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;background:radial-gradient(ellipse at 50% 37%,#2c3a4f,#1a2230 64%);padding:24px 18px;color:#f6f2ea;text-align:center}.machine-topline{position:absolute;top:22px;left:22px;right:22px;display:flex;justify-content:space-between;font:9px var(--mono);letter-spacing:.09em;color:#c3cad4}.machine-topline i{display:inline-block;width:5px;height:5px;background:#c5edda;border-radius:50%;margin-right:7px;box-shadow:0 0 12px #c5edda}.machine-stage{width:min(100%,390px);height:310px;position:relative;flex-shrink:0}.machine-grid{position:absolute;inset:15px;background-image:radial-gradient(#f0bcae30 1px,transparent 1px);background-size:19px 19px;mask-image:radial-gradient(ellipse,#000,transparent 70%)}.machine-apparatus{position:absolute;width:280px;height:280px;inset:15px 0 0;margin:auto;filter:drop-shadow(0 10px 24px #0a0f1866)}.machine-orbit{position:absolute;inset:28px 36px;border:1px solid #e8a08f40;border-radius:50%;animation:machine-spin 14s linear infinite}.machine-orbit span{position:absolute;left:14%;top:8%;font:24px var(--sans);color:#f0bcae;background:#2a3546;border-radius:50%;width:32px;height:32px;line-height:32px}.orbit-two{inset:4px 70px;transform:rotate(35deg);animation-duration:21s;animation-direction:reverse;border-style:dashed}.orbit-two span{color:#c5edda;font-size:29px}.orbit-three{inset:60px 8px;animation-duration:18s}.orbit-three span{color:#efafc7;font-style:italic}.machine-brain{transform-origin:160px 150px;animation:machine-float 3.4s ease-in-out infinite}.machine-eyes{transform-origin:160px 160px;animation:machine-blink 5s infinite}.machine-valve{transform-origin:55px 212px;animation:machine-spin 5s steps(8) infinite}.machine-antenna{transform-origin:160px 63px;animation:machine-wiggle 2.2s ease-in-out infinite}.machine-spark{animation:machine-twinkle 2.7s ease-in-out infinite}.machine-signal{stroke-dasharray:54;animation:machine-signal 1.8s linear infinite}.machine-lamp{animation:machine-twinkle 1.1s ease-in-out infinite}.machine-particle{position:absolute;color:#f0bcae;font:22px var(--sans);animation:machine-drift 4s ease-in-out infinite}.p-one{left:20%;top:38%;--drift:-25px}.p-two{right:16%;top:46%;--drift:20px;animation-delay:-1s;color:#c5edda}.p-three{left:39%;top:15%;--drift:-15px;animation-delay:-2s}.p-four{right:29%;top:23%;--drift:28px;animation-delay:-3s;color:#efafc7}.lab-machine h3{font:750 clamp(27px,3vw,39px)/1.1 var(--sans);letter-spacing:-.04em;margin:0 0 14px}.machine-activity{font:12px/1.5 var(--mono);color:#c5edda;max-width:36ch;min-height:36px;margin:0 0 8px}.machine-caption{font:12px/1.5 var(--mono);color:#c3cad4;margin:0 0 26px;min-height:36px;max-width:32ch}.machine-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;font:9px/1.5 var(--mono);color:#aeb7c3;margin-top:23px}.machine-foot button{color:#f0bcae;background:none;border:0;border-bottom:1px solid #e8a08f60;padding:4px 0;font:inherit;cursor:pointer}.lab-machine[data-paused="true"] *{animation-play-state:paused!important}.image-lab:not([data-working="true"]) #lab-invention{animation:machine-reveal .7s ease-out}.image-lab[data-working="true"] .lab-preview{min-height:620px}@keyframes machine-spin{to{transform:rotate(360deg)}}@keyframes machine-float{0%,100%{transform:translateY(4px) rotate(-5deg)}50%{transform:translateY(-9px) rotate(5deg)}}@keyframes machine-blink{0%,43%,47%,100%{transform:scaleY(1)}45%{transform:scaleY(.1)}}@keyframes machine-wiggle{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}@keyframes machine-twinkle{50%{opacity:.25}}@keyframes machine-signal{to{stroke-dashoffset:-108}}@keyframes machine-drift{0%{opacity:0;transform:translate(0,30px) scale(.5)}40%{opacity:.8}100%{opacity:0;transform:translate(var(--drift),-70px) rotate(90deg)}}@keyframes machine-reveal{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}@media(max-width:560px){.machine-stage{width:300px;max-width:100%}.machine-foot{font-size:8px}.machine-topline{font-size:8px}}@media(prefers-reduced-motion:reduce){.lab-machine *,#lab-invention{animation:none!important}.machine-foot button{display:none}}
    @media(max-width:860px){.wrap,.narrow{width:calc(100% - 40px)}.topbar{height:72px}.nav{gap:18px}.hero{padding-top:32px}.lede{font-size:18px}.shot{margin-top:44px}.essay{padding-top:80px}.things,.try-intro,.install{grid-template-columns:1fr;gap:40px}.things figure{position:static}.platforms li{grid-template-columns:1fr;gap:4px}}
    @media(max-width:560px){.wrap,.narrow{width:calc(100% - 32px)}.nav a:first-child{display:none}.brand{font-size:19px}h1{font-size:44px}.essay p,.closing p{font-size:18px}.essay .section-title+p{font-size:20px}.features>div{padding:20px 20px 20px 70px}.features>div:before{left:18px;top:20px}.actions .button{flex:1}.workspace-connect{flex-direction:column;align-items:stretch;gap:16px}.workspace-connect button{align-self:flex-start}.lab-top{padding:24px}.lab-controls{padding:22px}.lab-preview{padding:12px}.lab-bottom{padding:16px 22px}.lab-top h2{font-size:32px}footer{align-items:flex-start;flex-direction:column;gap:16px}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.button,.features>div{transition:none}.button:hover,.features>div:hover{transform:none}}
  </style>
</head>
<body>
  <header class="wrap topbar"><a class="brand" href="#top" aria-label="Vibestudio home"><picture class="brand-mark"><source media="(prefers-color-scheme: dark)" data-scheme="dark" srcset="/brand/vibestudio-symbol-dark.svg"><img src="/brand/vibestudio-symbol.svg" alt=""></picture>Vibestudio</a><nav class="nav" aria-label="Main navigation"><a href="https://github.com/panticonic/vibestudio">GitHub</a><a href="#install">Download</a><button class="theme-toggle" id="theme-toggle" type="button" aria-label="Dark mode" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/></svg></button></nav></header>
  <main id="top">
    <section class="wrap hero">
      <p class="eyebrow"><i></i>Open source, very much alpha</p>
      <h1>Build and share deeply <span class="accent">AI-infused apps</span></h1>
      <p class="lede">Vibestudio is a browser for apps with agents inside them. Build your own with an agent, or open someone else’s and let it run on your models, reaching only what you allow.</p>
      <div class="actions"><a class="button primary" href="#install">Download</a><a class="button secondary" href="https://github.com/panticonic/vibestudio">Source on GitHub</a></div>
      <p class="fine">For macOS, Windows and Linux.</p>
      <figure class="shot"><img src="/site/regency-game.webp" width="1600" height="900" alt="Vibestudio showing an agent-driven adventure game, with a generated painting of a council chamber next to the story text and a sidebar of workspaces"><figcaption>A small adventure game from the example workspace. Your advisors are agents, and the pictures are generated as you play.</figcaption></figure>
    </section>

    <section class="narrow essay" aria-labelledby="why">
      <span class="kicker">The idea</span>
      <h2 class="section-title" id="why">There’s more to AI-UX than a chat box</h2>
      <p>Most AI apps follow the same template: the app, a chat box in the corner, a few tools wired up behind it. I think interfaces can do a lot more than that. They could generate parts of themselves while you use them, work with your own data, and drop agents into games and tools wherever an agent actually helps.</p>
      <p>Actually turning that hot take into something better isn’t quite as straightforward though. The models we write code with learned from software that came before any of this. And I think it is also really easy to suffer from a lack of imagination here. So I built Vibestudio as an intuition pump to move in the direction of what comes next.</p>
      <p>When JS-enabled browsers were initially introduced, when the first web-apps started working, they made new software something you could try in seconds instead of minutes or hours. Even today, your agent can build something roughly right in minutes, but making it delightful still takes hours. It’s worth a lot to open something another person already thought hard about, and run it on your own AI — but we need a runtime to connect 3rd party AI-enabled apps to your agentic environment.</p>
    </section>

    <section class="wrap watch" aria-label="Video">
      <figure class="video"><iframe src="https://www.youtube-nocookie.com/embed/Pb6C4ORBOOI" title="There’s got to be more to AI-enabled user experience: an introduction to Vibestudio and a live demo" loading="lazy" allow="encrypted-media; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe><figcaption>The longer version: why I think this matters, then a live demo of building an app, importing tabs and connecting this very page. <a href="https://www.youtube.com/watch?v=Pb6C4ORBOOI">Watch on YouTube</a>.</figcaption></figure>
    </section>

    <section class="wrap things" aria-labelledby="what">
      <dl class="features">
        <div><dt id="what">Build apps by asking for them</dt><dd>Describe a tool and an agent builds it in your workspace, with a database, background jobs and version control already set up. The chat panel is one of those apps too, so you can change it. In the demo I asked for a purple chat and got one.</dd></div>
        <div><dt>Open apps other people made</dt><dd>A website can ask to connect to your workspace, a bit like a web3 site asks to connect to a wallet. Connecting grants almost nothing. After that the page asks for specific things, like your model provider or one folder, and you approve each one.</dd></div>
        <div><dt>Keep your keys out of reach</dt><dd>Credentials stay outside the sandbox. Apps and agents get narrow capabilities instead of passwords, and approval prompts appear in Vibestudio’s own interface, where an agent can’t fake or click them.</dd></div>
        <div><dt>Bring your browser along</dt><dd>Import your tabs and cookies and you’re still logged in everywhere. Once you allow it, an agent can read those pages and work in them, so a Trello board can become the start of a new app.</dd></div>
      </dl>
      <figure><img src="/site/approval-prompt.webp" width="694" height="400" alt="A Vibestudio approval prompt: an agent asks to inspect a panel with developer tools, with buttons to allow once, allow for this task, or not allow"><figcaption>An agent asking to look inside a Trello tab. You can allow it once, for the current task, or not at all.</figcaption></figure>
    </section>

    <section class="wrap try" id="try" aria-labelledby="try-title">
      <div class="try-intro"><div><span class="kicker">Live demo</span><h2 class="section-title" id="try-title">Try it on this page</h2></div><p>This page is one of those websites. Open vibestudio.app inside Vibestudio and connect it to a workspace. It will ask to start an agent there and build you something odd.</p></div>
      <div class="workspace-connect"><div><p id="workspace-connection-status" role="status" aria-live="polite">This page starts without workspace access.</p><p id="workspace-capabilities" role="status" aria-live="polite"></p></div><button class="button secondary" id="workspace-connect-button" type="button" disabled>Connect to workspace</button><noscript><p class="fine">Connecting needs JavaScript. Downloads work without it.</p></noscript></div>
        <section class="image-lab" id="image-lab" aria-label="Bureau of Impossible Inventions" hidden>
          <div class="lab-top"><div><h2>Bureau of Impossible Inventions</h2><p>Name two things that should never meet. An agent in your workspace builds the result, usually with a bit of AI of its own inside.</p></div></div>
          <div class="lab-body"><div class="lab-controls">
            <label for="lab-prompt">What has no business existing?</label><textarea id="lab-prompt" maxlength="1200" rows="3">An orchestra of AI agents that turns my feelings into weather reports from imaginary worlds</textarea>
            <div class="lab-ideas" aria-label="Unlikely collisions"><button type="button" data-idea="An AI gardener that grows illustrated tiny cities from my compliments">Compliments × cities</button><button type="button" data-idea="An agentic time machine that interviews my houseplants about their possible futures">Houseplants × time travel</button><button type="button" data-idea="A pocket moon whose AI astronomer invents new constellations from my mood">Moods × moon tides</button></div>
            <button class="button primary lab-submit" id="lab-generate" type="button">Invent the impossible</button>
            <p class="lab-note">This uses your own model subscription. Vibestudio will ask before the agent touches anything new.</p>
            <div class="lab-status" id="lab-status" role="status" aria-live="polite"></div>
            <ol class="lab-transcript" id="lab-transcript" aria-label="Conversation with your inventor"></ol>
            <form id="lab-revision-form"><label for="lab-revision">Then ask for changes.</label><input id="lab-revision" maxlength="1200" placeholder="What if it could…" autocomplete="off"><div class="lab-revision-actions"><button class="lab-secondary" id="lab-revise" type="submit" disabled>Ask the inventor ↗</button><button class="lab-secondary" id="lab-weirder" type="button" disabled>Make it weirder ✧</button></div></form>
          </div><div class="lab-preview"><div class="lab-machine" id="lab-machine" hidden aria-label="The inventor is working">
  <div class="machine-topline"><span><i></i> Agent working</span><span id="lab-elapsed">00:00</span></div>
  <div class="machine-stage" aria-hidden="true">
    <div class="machine-grid"></div><div class="machine-orbit orbit-one"><span>✦</span></div><div class="machine-orbit orbit-two"><span>☂</span></div><div class="machine-orbit orbit-three"><span>?</span></div>
    <svg class="machine-apparatus" viewBox="0 0 320 310" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="jar-light" x1="100" y1="80" x2="230" y2="230" gradientUnits="userSpaceOnUse"><stop stop-color="#b9f6de" stop-opacity=".2"/><stop offset="1" stop-color="#e8a08f" stop-opacity=".02"/></linearGradient></defs>
        <path d="M87 245H55V197H26" stroke="#e8a08f" stroke-width="7"/><path d="M234 229H275V171H298" stroke="#e8a08f" stroke-width="7"/>
        <g class="machine-valve"><circle cx="55" cy="212" r="15" fill="#243042" stroke="#e8a08f" stroke-width="2"/><path d="M44 212h22m-11-11v22" stroke="#e8a08f" stroke-width="2"/></g>
        <path d="M95 235V129a65 65 0 0 1 130 0v106" fill="url(#jar-light)" stroke="#f0bcae" stroke-width="2"/><path d="M109 165v-35a51 51 0 0 1 39-50" stroke="#f6f2ea" stroke-opacity=".4" stroke-width="3" stroke-linecap="round"/>
        <g class="machine-brain"><path d="M131 168c-15-2-21-23-7-33-2-19 20-29 32-15 11-19 38-12 37 9 22 3 25 31 7 41-2 20-28 24-40 10-10 15-33 7-29-12Z" fill="#c5edda" stroke="#f6f2ea" stroke-width="2"/><path d="M151 131c-10 0-15 9-8 16m24-22c-8 6-6 16 3 19m17-5c-9 4-9 15-2 19" stroke="#617e70" stroke-width="2" stroke-linecap="round"/><g class="machine-eyes" fill="#243042"><ellipse cx="147" cy="161" rx="3" ry="5"/><ellipse cx="173" cy="161" rx="3" ry="5"/></g><path d="M155 174q5 5 10 0" stroke="#243042" stroke-width="2" stroke-linecap="round"/></g>
        <g class="machine-spark" stroke="#f6d996" stroke-width="2"><path d="M160 91v-16m-8 8h16M111 201v-12m-6 6h12m84-8v-12m-6 6h12"/></g>
        <rect x="78" y="235" width="164" height="42" rx="9" fill="#e8a08f"/><rect x="100" y="246" width="63" height="19" rx="3" fill="#243042"/><path class="machine-signal" d="M105 256h8l4-6 6 12 5-9 5 3h24" stroke="#c5edda" stroke-width="2"/>
        <circle cx="190" cy="256" r="7" fill="#243042"/><circle class="machine-lamp" cx="215" cy="256" r="5" fill="#c5edda"/><path d="M94 277v10m132-10v10" stroke="#e8a08f" stroke-width="8" stroke-linecap="round"/>
        <path class="machine-antenna" d="M160 63V44m-12 0 12-12 12 12" stroke="#e8a08f" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <div class="machine-particle p-one">✧</div><div class="machine-particle p-two">+</div><div class="machine-particle p-three">✦</div><div class="machine-particle p-four">∴</div>
  </div>
  <h3>Reality, please hold.</h3><p class="machine-activity" id="lab-activity" role="status">Opening the inventor’s workspace</p><p class="machine-caption" id="lab-machine-caption" aria-hidden="true">Warming up the what-if engine…</p>
  <div class="machine-foot"><span>A real agent is working. There is no progress bar.</span><button id="lab-motion" type="button">Pause animation</button></div>
</div>
<div class="lab-placeholder" id="lab-placeholder"><div class="lab-orbit" aria-hidden="true"><span>?</span></div><h3>Nothing here yet.</h3><p>Your invention will show up here once the agent has built it.</p></div><iframe id="lab-invention" title="Your interactive invention" referrerpolicy="no-referrer" hidden></iframe><p id="lab-preview-caption">Built by an agent in your workspace.</p><a class="lab-download" id="lab-download" download="impossible-invention.html" hidden>Keep this invention ↓</a></div></div>
          <div class="lab-bottom"><p id="lab-location"><span class="lab-working-dot"></span>Not saved yet</p><button class="lab-secondary" id="lab-refresh" type="button">Refresh preview</button></div>
        </section>
    </section>

    <section class="wrap install" id="install" aria-labelledby="install-title">
      <div class="install-copy"><span class="kicker">Install</span><h2 class="section-title" id="install-title">Get it</h2><p>Install the desktop app, open a workspace, and tell the onboarding agent what you want to do. It works best with a ChatGPT (Codex) subscription right now. API keys and local models can be connected too, but get less testing.</p><p>Want it always on? Run Vibestudio on a <a href="https://github.com/panticonic/vibestudio#running-a-server">home server</a> and connect your laptop and phone to it.</p><div class="actions"><a class="button primary" href="https://panticonic.github.io/vibestudio/" data-carry-theme>All downloads</a><a class="button secondary" href="https://github.com/panticonic/vibestudio/releases/latest">Latest release</a></div></div>
      <ul class="platforms"><li><b>macOS</b><span><a href="/download/mac">Download for Mac</a> (Apple Silicon, macOS 14+).<br>Or use Homebrew: <code>brew install --cask panticonic/tap/vibestudio</code></span></li><li><b>Debian / Ubuntu</b><span>Add the signed apt repository from the <a href="https://panticonic.github.io/vibestudio/" data-carry-theme>downloads page</a>, then <code>apt install vibestudio</code>.</span></li><li><b>Fedora / RHEL</b><span>Add the RPM repository, then <code>dnf install vibestudio</code>.</span></li><li><b>Windows</b><span>Run the .exe installer from the latest release. It isn’t code-signed yet, so SmartScreen will warn you.</span></li></ul>
    </section>

    <section class="narrow closing" aria-label="A note on status">
      <p>Vibestudio is alpha software. Things will break, the approval prompts are still too chatty, and some of the example apps are rough. Please read about the <a href="https://github.com/panticonic/vibestudio/blob/main/docs/permission-system.md">permission system</a> before you connect anything sensitive.</p>
      <p>If you build something strange with it, or find what breaks, <a href="https://github.com/panticonic/vibestudio/issues">tell me</a>.</p>
      <p class="sig">Gabe</p>
    </section>
  </main>
  <footer class="wrap"><span>Vibestudio</span><nav class="footer-links" aria-label="Footer"><a href="https://github.com/panticonic/vibestudio">GitHub</a><a href="https://github.com/panticonic/vibestudio/releases/latest">Releases</a><a href="https://github.com/panticonic/vibestudio/blob/main/README.md">Docs</a></nav></footer>
  <script nomodule>var status = document.getElementById("workspace-connection-status"); if (status) status.textContent = "Connecting needs a newer browser. Downloads work without it.";</script>
  <script type="module" src="/connect.js"></script>
</body>
</html>`;

/** Browser fallback for a canonical logical panel-location universal link. */
export function handlePanelLanding(): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Vibestudio panel</title><style>${CONNECTION_PAGE_CSS}</style><main><h1>Open Vibestudio panel</h1><p id="status">Preparing panel link.</p><p><button id="open" type="button">Open in Vibestudio</button></p><p class="muted">Panel links can contain workspace state arguments. Only open links from a source you trust.</p><p><code id="link"></code></p></main><script>(()=>{const fragment=location.hash?location.hash.slice(1):"";const status=document.getElementById("status");const link=document.getElementById("link");const open=document.getElementById("open");if(!fragment){status.textContent="This panel URL is missing its location fragment.";open.disabled=true;return}const scheme="vibestudio://panel?"+fragment;link.textContent=scheme;open.addEventListener("click",()=>{location.href=/Android/i.test(navigator.userAgent)?"intent://panel?"+fragment+"#Intent;scheme=vibestudio;package=app.vibestudio.mobile;end":scheme});status.textContent="Open this logical panel location in Vibestudio."})()</script></html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    }
  );
}

// ---- Universal-link host (Apple App Site Association / Android assetlinks) ---

export interface UniversalLinkConfig {
  /** `<teamId>.<bundleId>` app IDs that may claim the relay's links. */
  appleAppIds: string[];
  androidPackageName?: string;
  /** Uppercase colon-separated SHA-256 signing-cert fingerprints. */
  androidFingerprints: string[];
}

export function universalLinkConfigFromEnv(env: {
  VIBESTUDIO_APPLE_APP_ID?: string;
  VIBESTUDIO_ANDROID_PACKAGE_NAME?: string;
  VIBESTUDIO_ANDROID_SHA256_CERT_FINGERPRINTS?: string;
}): UniversalLinkConfig {
  return {
    appleAppIds: splitList(env.VIBESTUDIO_APPLE_APP_ID),
    androidPackageName: env.VIBESTUDIO_ANDROID_PACKAGE_NAME?.trim() || undefined,
    androidFingerprints: splitList(env.VIBESTUDIO_ANDROID_SHA256_CERT_FINGERPRINTS).map((f) =>
      f.toUpperCase()
    ),
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Apple App Site Association. The `*` component lets the OS hand
 * `/oauth/callback/<transactionId>?code&state` straight into the app. Returns
 * null when no Apple app id is configured (the route fails loud rather than
 * serving a broken association that breaks universal links on every device).
 */
export function buildAppleAppSiteAssociation(config: UniversalLinkConfig): unknown | null {
  if (config.appleAppIds.length === 0) return null;
  return {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: config.appleAppIds,
          components: [
            { "/": "/oauth/callback/*", comment: "OAuth provider callbacks" },
            { "/": "/oauth/linkback/*", comment: "OAuth account-linking callbacks" },
            { "/": "/p", comment: "Pairing trampoline" },
            { "/": "/panel", comment: "Logical panel location" },
          ],
        },
      ],
    },
    webcredentials: { apps: config.appleAppIds },
  };
}

/** Android App Links assetlinks. Returns null when unconfigured. */
export function buildAssetlinks(config: UniversalLinkConfig): unknown | null {
  if (!config.androidPackageName || config.androidFingerprints.length === 0) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: config.androidPackageName,
        sha256_cert_fingerprints: config.androidFingerprints,
      },
    },
  ];
}

// ---- Minimal landing pages --------------------------------------------------

function htmlPage(status: number, title: string, body: string): Response {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${CONNECTION_PAGE_CSS}</style><body><main><h1>${safeTitle}</h1><p>${safeBody}</p></main></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }
  );
}

function htmlError(status: number, title: string, body: string): Response {
  return htmlPage(status, title, body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAIR_LANDING_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair Vibestudio</title>
<style>${CONNECTION_PAGE_CSS}</style>
<main>
  <h1>Pair Vibestudio</h1>
  <p id="status">Preparing pairing link.</p>
  <p><button id="open" type="button">Open in Vibestudio</button></p>
  <p class="muted" id="install">If Vibestudio is not installed, install the app from your organization’s distribution source, then return to this page.</p>
  <p><code id="link"></code></p>
</main>
<script>
(() => {
  const fragment = location.hash ? location.hash.slice(1) : "";
  const status = document.getElementById("status");
  const link = document.getElementById("link");
  const open = document.getElementById("open");
  if (!fragment) {
    status.textContent = "This pair URL is missing its private fragment. Scan a fresh QR from Vibestudio.";
    open.disabled = true;
    return;
  }
  const scheme = "vibestudio://connect/" + fragment;
  link.textContent = scheme;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const openLink = () => {
    if (isAndroid) {
      location.href = "intent://connect/" + fragment + "#Intent;scheme=vibestudio;package=app.vibestudio.mobile;end";
      return;
    }
    location.href = scheme;
  };
  if (isAndroid) {
    status.textContent = "Opening Vibestudio. If it does not open, install the Android shell and retry.";
    setTimeout(openLink, 50);
  } else if (isIos) {
    status.textContent = "Tap Open in Vibestudio. If the app is not installed, install it first and then return to this page.";
  } else {
    status.textContent = "Click Open in Vibestudio if it is installed on this computer, or open this page on a paired phone.";
  }
  open.addEventListener("click", openLink);
})();
</script>
</html>`;
