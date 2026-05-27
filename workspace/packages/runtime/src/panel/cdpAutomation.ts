import type { RpcBridge } from "@natstack/rpc";
import type { CdpAutomation, CdpEndpoint } from "../core/index.js";

export type { CdpAutomation, CdpEndpoint };

type PlaywrightClientModule = {
  BrowserImpl: { connect(ws: string, opts: object): Promise<any> };
};

async function loadPlaywrightClient(): Promise<PlaywrightClientModule> {
  const runtimeRequire = (globalThis as Record<string, unknown>)["__natstackRequire__"] as
    | ((id: string) => unknown)
    | undefined;
  if (runtimeRequire) {
    try {
      const loaded = runtimeRequire("@workspace/playwright-client") as
        | PlaywrightClientModule
        | undefined;
      if (loaded?.BrowserImpl?.connect) return loaded;
    } catch {
      // Panels can lazily import npm packages via __natstackRequireAsync__ below.
      // Workers only have the sync module map, so a missing map entry should
      // fall through to the clearest environment-specific loader/error.
    }
  }
  const runtimeRequireAsync = (globalThis as Record<string, unknown>)[
    "__natstackRequireAsync__"
  ] as
    | ((id: string) => Promise<unknown>)
    | undefined;
  if (runtimeRequireAsync) {
    const loaded = (await runtimeRequireAsync("@workspace/playwright-client")) as
      | PlaywrightClientModule
      | undefined;
    if (loaded?.BrowserImpl?.connect) return loaded;
  }
  const dynamicImport = new Function("id", "return import(id)") as (
    id: string
  ) => Promise<PlaywrightClientModule>;
  return dynamicImport("@workspace/playwright-client");
}

export function createCdpAutomation(rpc: RpcBridge, id: string): CdpAutomation {
  const getCdpEndpoint = async (): Promise<CdpEndpoint> => {
    return rpc.call<CdpEndpoint>("main", "panelCdp.getCdpEndpoint", [id]);
  };

  const page = async (): Promise<any> => {
    const { BrowserImpl } = await loadPlaywrightClient();
    const endpoint = await getCdpEndpoint();
    const options: { isElectronWebview: boolean; transportOptions?: { authToken: string } } = {
      isElectronWebview: true,
    };
    if (endpoint.token) options.transportOptions = { authToken: endpoint.token };
    const browser = await BrowserImpl.connect(endpoint.wsEndpoint, options);
    const resolvedPage = browser.contexts()[0]?.pages()[0];
    if (!resolvedPage) throw new Error("No page found in panel CDP target");
    return resolvedPage;
  };

  return {
    page,
    getCdpEndpoint,
    navigate: (url) => {
      return rpc.call<void>("main", "panelCdp.navigate", [id, url]);
    },
    goBack: () => {
      return rpc.call<void>("main", "panelCdp.goBack", [id]);
    },
    goForward: () => {
      return rpc.call<void>("main", "panelCdp.goForward", [id]);
    },
    reload: () => {
      return rpc.call<void>("main", "panelCdp.reload", [id]);
    },
    stop: () => {
      return rpc.call<void>("main", "panelCdp.stop", [id]);
    },
    click: async (selector) => {
      const p = await page();
      await p.click(selector);
    },
    screenshot: async (options) => {
      const p = await page();
      return p.screenshot(options);
    },
  };
}
