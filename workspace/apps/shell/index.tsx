import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider as JotaiProvider } from "jotai";
import "@radix-ui/themes/styles.css";
import "@workspace/ui/tokens.css";
import "./styles/overrides.css";

/**
 * The shell bundle serves two surfaces:
 *  - the full app (`<App/>`), and
 *  - a content-overlay surface (`#overlaySurface=<key>`) loaded into a separate
 *    transparent native view floating above the panels.
 * `App` is imported dynamically so the overlay path never evaluates
 * `shell/client` (which throws without the RPC transport the overlay lacks).
 */
function parseOverlaySurface(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  return new URLSearchParams(hash).get("overlaySurface");
}

function renderInitError(container: HTMLElement, error: unknown): void {
  container.textContent = "";
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "color: red; padding: 20px; font-family: monospace;";
  const heading = document.createElement("h2");
  heading.textContent = "Failed to initialize app";
  const msg = document.createElement("pre");
  msg.textContent = error instanceof Error ? error.message : String(error);
  const stack = document.createElement("pre");
  stack.textContent = error instanceof Error ? (error.stack ?? "") : "";
  wrapper.append(heading, msg, stack);
  container.appendChild(wrapper);
}

async function initializeApp(): Promise<void> {
  const container = document.getElementById("app");
  if (!container) {
    console.error("Renderer root not found");
    return;
  }
  const root = createRoot(container);
  try {
    const overlaySurface = parseOverlaySurface();
    if (overlaySurface) {
      // Surface mode: transparent document so the live panel shows through
      // everywhere except the surface card itself.
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
      container.style.background = "transparent";
      const { OverlaySurfaceHost } = await import("./overlay/OverlaySurfaceHost");
      root.render(
        <StrictMode>
          <OverlaySurfaceHost />
        </StrictMode>
      );
      return;
    }

    const { App } = await import("./components/App");
    root.render(
      <StrictMode>
        <JotaiProvider>
          <App />
        </JotaiProvider>
      </StrictMode>
    );
  } catch (error) {
    console.error("Failed to initialize app:", error);
    renderInitError(container, error);
  }
}

void initializeApp();
