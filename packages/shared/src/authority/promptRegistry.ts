export const AUTHORITY_PROMPT_CARD_TYPES = [
  "permission.gated",
  "permission.outside",
  "confirm.critical",
  "template.add",
  "template.update",
  "template.remove",
  "template.suggest",
] as const;

export type AuthorityPromptCardType = (typeof AUTHORITY_PROMPT_CARD_TYPES)[number];

export const AUTHORITY_PROMPT_REGISTRY = {
  "permission.gated": {
    title: "Allow {agent} to {action}?",
    body: "{agent} wants to {action} while working on this task.",
    actions: ["Allow for this task", "Just once", "Don't allow"],
    push: "permission",
  },
  "permission.outside": {
    banner: "This task includes content from an outside source: {source}.",
    title: "Allow {agent} to {action}?",
    body: "{agent} wants to {action} while working on this task.",
    actions: ["Allow for this task", "Just once", "Don't allow"],
    push: "permission",
  },
  "confirm.critical": {
    title: "Confirm {agent} should {action}?",
    body: "This action can't be undone. Check the details before confirming.",
    actions: ["Confirm", "Don't allow"],
    push: "none",
  },
  "template.add": {
    title: "Add this template?",
    body: "Review what it adds and any choices before continuing.",
    actions: ["Add template", "Not now"],
    push: "none",
  },
  "template.update": {
    title: "Update this template?",
    body: "Review what changes and anything you changed too.",
    actions: ["Update", "Not now"],
    push: "update",
  },
  "template.remove": {
    title: "Remove this template?",
    body: "Its parts stay in your workspace and become yours to manage.",
    actions: ["Remove", "Cancel"],
    push: "none",
  },
  "template.suggest": {
    title: "Suggest your changes?",
    body: "Your workspace won't change. The maintainers can review what you send.",
    actions: ["Send suggestion", "Cancel"],
    push: "none",
  },
} as const satisfies Record<AuthorityPromptCardType, unknown>;

export function authorityPromptCardType(input: {
  tier: "gated" | "critical";
  capability: string;
  outsideContent: boolean;
}): AuthorityPromptCardType {
  if (input.tier === "critical") return "confirm.critical";
  for (const operation of ["add", "update", "remove", "suggest"] as const) {
    if (input.capability.includes(`/workspace.templates.${operation}#`)) {
      return `template.${operation}`;
    }
  }
  return input.outsideContent ? "permission.outside" : "permission.gated";
}

const BANNED =
  /\b(principal|capability|grant|scope|session|mission|taint(?:ed)?|lineage|provenance|vouch|digest|hash|harness|eval|snippet|conduit|tier|attestation|origin|subject|envelope|acquisition|invocation|resource|delegation|integrity|artifact|closure|RPC|DO|dispatcher)\b/i;
const TEMPLATE_BANNED = /\b(monorepo|DAG|node|pin|lock|fragment|subtree|upstream|ref|OID)\b/i;

export function assertAuthorityPromptRegistry(): void {
  for (const [id, card] of Object.entries(AUTHORITY_PROMPT_REGISTRY)) {
    for (const text of [
      card.title,
      card.body,
      ...card.actions,
      "banner" in card ? card.banner : "",
    ]) {
      if (BANNED.test(text))
        throw new Error(`Authority prompt ${id} contains banned system vocabulary`);
      if (id.startsWith("template.") && TEMPLATE_BANNED.test(text)) {
        throw new Error(`Template prompt ${id} contains banned implementation vocabulary`);
      }
    }
    if (card.actions.length > 3) throw new Error(`Authority prompt ${id} exposes too many actions`);
  }
}
