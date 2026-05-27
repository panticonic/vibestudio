import { BrowserImpl } from "../../playwright-core/src/client/browserImpl";

export type Browser = Awaited<ReturnType<typeof BrowserImpl.connect>>;

export { BrowserImpl };

export type Options = {
  headless?: boolean;
};

export async function connect(
  wsEndpoint: string,
  _browserName: string,
  options: Options & { authToken?: string } = {}
): Promise<Browser> {
  return BrowserImpl.connect(wsEndpoint, {
    isElectronWebview: true,
    transportOptions: options.authToken ? { authToken: options.authToken } : undefined,
  });
}
