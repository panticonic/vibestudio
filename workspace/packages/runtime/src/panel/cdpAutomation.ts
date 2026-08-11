import type { RpcClient } from "@vibestudio/rpc";
import type { Browser, CdpPage } from "@workspace/cdp-client";
import type {
  CdpAutomation,
  CdpEndpoint,
  PanelConsoleHistoryOptions,
  PanelConsoleHistoryResult,
  PanelScreenshotOptions,
  PanelScreenshotResult,
} from "../core/index.js";

export type { CdpAutomation, CdpEndpoint };

type CdpClientModule = {
  BrowserImpl: { connect(ws: string, opts: object): Promise<Browser> };
};

const CDP_CLIENT_MODULE = "@workspace/cdp-client";

interface CdpAutomationOptions {
  kind?: "workspace" | "browser";
  requesterPanelId?: string | null;
  /** Closure-held module resolver used by confined hosted runtimes. */
  loadModule?: (id: string) => unknown | Promise<unknown>;
  navigate?: (url: string) => Promise<void>;
  navigateHistory?: (delta: -1 | 1) => Promise<void>;
  reload?: () => Promise<void>;
}

function isCdpClientModule(value: unknown): value is CdpClientModule {
  return Boolean((value as CdpClientModule | undefined)?.BrowserImpl?.connect);
}

async function loadCdpClient(
  loadModule?: (id: string) => unknown | Promise<unknown>
): Promise<CdpClientModule> {
  if (loadModule) {
    try {
      const loaded = await loadModule(CDP_CLIENT_MODULE);
      if (isCdpClientModule(loaded)) return loaded;
      throw new Error("module does not expose BrowserImpl.connect");
    } catch (error) {
      // A closure-held loader is the hosted runtime's authority-bearing module
      // path. Falling through would hide its failure behind another runtime.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load ${CDP_CLIENT_MODULE} for CDP automation. ${message}`, {
        cause: error,
      });
    }
  }
  try {
    const loaded: unknown = await import("@workspace/cdp-client");
    if (isCdpClientModule(loaded)) return loaded;
    throw new Error("module does not expose BrowserImpl.connect");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to load ${CDP_CLIENT_MODULE} for CDP automation. ${message}. ` +
        `Call handle.cdp.page() only from contexts that expose @workspace/cdp-client.`,
      { cause: error }
    );
  }
}

export function createCdpAutomation(
  rpc: Pick<RpcClient, "call">,
  id: string,
  options: CdpAutomationOptions = {}
): CdpAutomation {
  // CDP automation is available for every panel target — workspace panels and
  // browser panels alike. (A prior commit restricted this to browser panels to
  // stop test agents from navigating the panel they were running in; that
  // over-corrected and blocked legitimate inspection of other workspace panels.)
  const getCdpEndpoint = async (): Promise<CdpEndpoint> => {
    return rpc.call<CdpEndpoint>("main", "panelCdp.getCdpEndpoint", [id]);
  };

  const connectPage = async (): Promise<CdpPage> => {
    const { BrowserImpl } = await loadCdpClient(options.loadModule);
    const endpoint = await getCdpEndpoint();
    const connectOptions: {
      isElectronWebview: boolean;
      preferFetchUpgrade: boolean;
      transportOptions?: { authToken: string };
    } = {
      isElectronWebview: true,
      // Hosted EvalDO runtimes receive a closure-held loader and must route
      // CDP through the egress-aware fetch-upgrade transport. Browser panels
      // use their native WebSocket implementation instead.
      preferFetchUpgrade: Boolean(options.loadModule),
    };
    if (endpoint.token) connectOptions.transportOptions = { authToken: endpoint.token };
    const browser = await BrowserImpl.connect(endpoint.wsEndpoint, connectOptions);
    const resolvedPage = browser.contexts()[0]?.pages()[0];
    if (!resolvedPage) {
      await browser.close();
      throw new Error(
        `CDP connected to panel ${JSON.stringify(id)}, but the target exposed no page. ` +
          "The panel may still be starting or its target may have been replaced; inspect " +
          "handle.diagnose() and retry handle.cdp.page() once the panel is ready."
      );
    }
    return resolvedPage;
  };

  return {
    page: connectPage,
    consoleHistory: (options?: PanelConsoleHistoryOptions) => {
      return rpc.call<PanelConsoleHistoryResult>("main", "panelCdp.consoleHistory", [id, options]);
    },
    getCdpEndpoint,
    navigate: (url) => {
      if (!options.navigate) throw new Error("Panel navigation runtime is unavailable");
      return options.navigate(url);
    },
    goBack: () => {
      if (!options.navigateHistory) {
        throw new Error("Panel history navigation runtime is unavailable");
      }
      return options.navigateHistory(-1);
    },
    goForward: () => {
      if (!options.navigateHistory) {
        throw new Error("Panel history navigation runtime is unavailable");
      }
      return options.navigateHistory(1);
    },
    reload: () => {
      if (!options.reload) throw new Error("Panel reload runtime is unavailable");
      return options.reload();
    },
    stop: () => {
      return rpc.call<void>("main", "panelCdp.stop", [id]);
    },
    click: async (selector) => {
      const p = await connectPage();
      await p.locator(selector).click();
    },
    screenshot: (options?: PanelScreenshotOptions) => {
      return rpc.call<PanelScreenshotResult>("main", "panelCdp.screenshot", [id, options]);
    },
  };
}
