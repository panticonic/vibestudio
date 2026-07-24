import type { PrincipalKind } from "@vibestudio/rpc";

export interface ProductDurableObjectWorkspaceService {
  readonly kind: "durable-object";
  readonly name: string;
  readonly title: string;
  readonly action: string;
  readonly description: string;
  readonly presentation: {
    readonly domain:
      | "files"
      | "sharing"
      | "accounts"
      | "web"
      | "automation"
      | "people"
      | "computer";
    readonly verb: "see" | "act" | "manage";
    readonly substanceKind?: "change-set" | "send" | "deletion" | "custom";
  };
  readonly protocols: readonly string[];
  readonly source: string;
  readonly authority: {
    readonly principals: readonly PrincipalKind[];
  };
  readonly durableObject: {
    readonly className: string;
    readonly objectKey: string;
  };
}

export const PRODUCT_WORKSPACE_SERVICES: readonly ProductDurableObjectWorkspaceService[];

export function findProductWorkspaceService(
  query: string
): ProductDurableObjectWorkspaceService | null;
