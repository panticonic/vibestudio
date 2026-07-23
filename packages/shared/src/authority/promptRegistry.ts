export const AUTHORITY_PROMPT_REGISTRY = {
  "permission.gated": {
    title: "Allow {agent} to {action}?",
    body: "{agent} wants to {action} while working on this task.",
    actions: ["Allow for this task", "Just once", "Don't allow"],
    push: "permission",
  },
  "permission.outside": {
    banner: "This task has read outside content: {source}.",
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
} as const;

export type AuthorityPromptCardType = keyof typeof AUTHORITY_PROMPT_REGISTRY;

const BANNED = /\b(principal|capability|grant|scope|session|mission|taint(?:ed)?|lineage|provenance|vouch|digest|hash|harness|eval|snippet|conduit|tier|attestation|origin|subject|envelope|acquisition|invocation|resource|delegation|integrity|artifact|closure|RPC|DO|dispatcher)\b/i;

export function assertAuthorityPromptRegistry(): void {
  for (const [id, card] of Object.entries(AUTHORITY_PROMPT_REGISTRY)) {
    for (const text of [card.title, card.body, ...card.actions, "banner" in card ? card.banner : ""]) {
      if (BANNED.test(text)) throw new Error(`Authority prompt ${id} contains banned system vocabulary`);
    }
    if (card.actions.length > 3) throw new Error(`Authority prompt ${id} exposes too many actions`);
  }
}
