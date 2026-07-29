import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import { normalizeRemoteUrl } from "./remoteUrl.js";

const FULL_SHA1 = /^[0-9a-f]{40}$/u;
const TEMPLATE_NODE_ID_HEX_LENGTH = 12;

/**
 * A template repository is only ever partially vendored: `enumerateRepoFiles`
 * takes container-section subtrees and ignores everything else. Refusing an
 * entire template because its root carries an ordinary `.npmrc` — which every
 * pnpm monorepo needs — would reject most realistic templates, so reserved
 * paths are excluded from the admitted set instead. Template discovery and
 * template acquisition MUST both use this constant, or the pin's snapshot
 * digest stops being reproducible between the two.
 */
export const TEMPLATE_RESERVED_PATH_POLICY = "exclude" as const;

/**
 * Declarative source manifest of a template repository.
 *
 * This is intentionally distinct from `meta/vibestudio.yml`, which is the
 * flattened runtime manifest consumed by the host in a running workspace.
 */
export const TEMPLATE_SOURCE_MANIFEST_PATH = "meta/template.yml";

/**
 * Template coordinates use `git+http(s)` as an identity scheme while Git
 * itself receives the underlying HTTP(S) transport URL.
 */
export function templateGitTransportUrl(value: string): string {
  return value.startsWith("git+") ? value.slice("git+".length) : value;
}

/** `https:` and `git+https:` are equivalent spellings of one template. */
export function normalizeTemplateGitUrl(value: string): string {
  return `git+${normalizeRemoteUrl(templateGitTransportUrl(value))}`;
}

/**
 * Stable display identity derived solely from the canonical template URL.
 *
 * The readable repository stem is intentionally followed by the same
 * content-addressed suffix for every occurrence. This prevents aliases from
 * changing when another template is added and makes author-chosen alias
 * collisions impossible under the same digest assumptions as node ids.
 */
export function templateAliasFromUrl(value: string): string {
  const url = normalizeTemplateGitUrl(value);
  const transport = new URL(templateGitTransportUrl(url));
  const repository =
    transport.pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/u, "")
      .replace(/^vibestudio-(?:template|workspace)-/u, "")
      .replace(/^template-/u, "")
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "template";
  const digest = sha256HexSyncText(
    canonicalJson({
      protocol: "vibestudio-template-alias-v1",
      url,
    })
  );
  return `${repository}-${digest.slice(0, TEMPLATE_NODE_ID_HEX_LENGTH)}`;
}

/** Stable identity of one immutable template snapshot. */
export function canonicalTemplateNodeId(url: string, commit: string): `t-${string}` {
  if (!FULL_SHA1.test(commit)) {
    throw new Error(
      "Canonical template node identity requires a full lowercase 40-character Git object id"
    );
  }
  const digest = sha256HexSyncText(
    canonicalJson({
      protocol: "vibestudio-template-node-v1",
      url: normalizeTemplateGitUrl(url),
      commit,
    })
  );
  return `t-${digest.slice(0, TEMPLATE_NODE_ID_HEX_LENGTH)}`;
}
