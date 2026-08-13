import { BrowserPrivacySectionSchema } from "@vibestudio/service-schemas/browserPrivacy";
import { browserPrivacyPresentationMethods } from "@vibestudio/service-schemas/browserPrivacyPresentation";
import { isReviewedBrowserDataProvider } from "@vibestudio/shared/browserDataProviderAuthority";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { verifiedInitiator } from "@vibestudio/shared/serviceDispatcher";

interface PresentationShell {
  caller: { runtime: { id: string; kind: string } };
  userId: string;
  clientPlatform?: string;
}

interface ClientBridge {
  call(callerId: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface BrowserPrivacyPresentationServiceDeps {
  browserDataBrokerRepoPath: string | null;
  getAuthorizingShell(principalId: string): PresentationShell | null;
  getClientBridge(callerId: string): ClientBridge | undefined;
}

/**
 * Resolve a panel's exact containing shell from the host-retained connection
 * grant issuer, then select one platform-specific native receiver. No identity
 * or platform supplied by workspace code participates in this decision.
 */
export function createBrowserPrivacyPresentationService(
  deps: BrowserPrivacyPresentationServiceDeps
): ServiceDefinition {
  return {
    name: "browserPrivacyPresentation",
    description: "Exact-shell router for the host-owned browser privacy manager",
    authority: { principals: ["code"] },
    methods: browserPrivacyPresentationMethods,
    handler: async (ctx, method, args) => {
      if (method !== "open") {
        throw new Error(`Unknown browserPrivacyPresentation method: ${method}`);
      }
      if (!isReviewedBrowserDataProvider(ctx, deps.browserDataBrokerRepoPath)) {
        throw new Error(
          "Browser privacy presentation requires the exact reviewed browser-data provider"
        );
      }
      const initiator = verifiedInitiator(ctx);
      if (initiator.runtime.kind !== "panel" && initiator.runtime.kind !== "app") {
        throw new Error("Browser privacy presentation must originate in a hosted panel or app");
      }
      const shell = deps.getAuthorizingShell(initiator.runtime.id);
      const userId = initiator.subject?.userId;
      if (
        !shell ||
        shell.caller.runtime.kind !== "shell" ||
        !userId ||
        userId === "system" ||
        shell.userId !== userId
      ) {
        throw new Error("The initiating panel has no exact live authorizing shell");
      }
      const section = BrowserPrivacySectionSchema.parse(args[0] ?? "credentials");
      if (shell.clientPlatform === "desktop") {
        const callerId = shell.caller.runtime.id;
        const bridge = deps.getClientBridge(callerId);
        if (!bridge) throw new Error("The authorizing desktop shell is disconnected");
        await bridge.call(callerId, "desktopBrowserPrivacyPresentation.open", [section]);
        return;
      }
      if (shell.clientPlatform === "mobile") {
        const callerId = shell.caller.runtime.id;
        const bridge = deps.getClientBridge(callerId);
        if (!bridge) throw new Error("The authorizing mobile shell is disconnected");
        await bridge.call(callerId, "mobileBrowserPrivacyPresentation.open", [section]);
        return;
      }
      throw new Error("Protected browser data is unavailable on the authorizing host platform");
    },
  };
}
