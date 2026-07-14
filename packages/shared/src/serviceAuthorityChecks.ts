import type { ServiceContext } from "./serviceDispatcher.js";
import { requirementForPrincipals } from "./authorization.js";

export const PANEL_HOSTING_CAPABILITY = "panel-hosting";
export const PANEL_HOSTING_RESOURCE = "platform:panel-hosting";

/**
 * Ask the dispatcher's canonical evaluator whether this exact call carries
 * panel-hosting authority. This replaces source/kind allowlists: product code
 * must request the capability in its immutable recipe and receive the exact
 * source grant, while host/user surfaces use their own separate principal.
 */
export async function hasPanelHostingAuthority(ctx: ServiceContext): Promise<boolean> {
  if (!ctx.authority) throw new Error("Compositional authority is unavailable");
  return await ctx.authority.allows({
    capability: PANEL_HOSTING_CAPABILITY,
    resourceKey: PANEL_HOSTING_RESOURCE,
    requirement: requirementForPrincipals(
      ["host", "user", "code"],
      PANEL_HOSTING_CAPABILITY
    ),
  });
}

export async function requirePanelHostingAuthority(
  ctx: ServiceContext,
  operation: string
): Promise<void> {
  if (await hasPanelHostingAuthority(ctx)) return;
  const error = new Error(`${operation} requires panel-hosting authority`) as Error & {
    code: string;
  };
  error.code = "EACCES";
  throw error;
}

export async function requireRuntimeCapability(
  ctx: ServiceContext,
  capability: string,
  operation: string,
  resourceKey = `platform:${capability}`
): Promise<void> {
  if (!ctx.authority) throw new Error("Compositional authority is unavailable");
  const allowed = await ctx.authority.allows({
    capability,
    resourceKey,
    requirement: requirementForPrincipals(["host", "user", "code"], capability),
  });
  if (allowed) return;
  const error = new Error(`${operation} requires '${capability}' authority`) as Error & {
    code: string;
  };
  error.code = "EACCES";
  throw error;
}
