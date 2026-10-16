import { invokeBackgroundIntent } from "@vibestudio/client-host-core";
import type { Call } from "@vibestudio/client-host-core";
import {
  clientIntents,
  type ClientIntentDecl,
  type ClientListing,
  type HostDescriptor,
} from "@vibestudio/workspace-contracts/clients";
import { UsageError } from "../../src/cli/output.js";

/** The declaration of the intent the person named; absent means the implicit `open`. */
export function resolveIntent(
  listing: Pick<ClientListing, "id" | "intents">,
  name: string | undefined
): ClientIntentDecl {
  const intents = clientIntents({ intents: listing.intents });
  const wanted = name ?? "open";
  const found = intents.find((intent) => intent.name === wanted);
  if (!found) {
    throw new UsageError(
      `Client ${listing.id} has no intent "${wanted}". It declares: ${intents.map((i) => i.name).join(", ")}.`
    );
  }
  return found;
}

/** `--param key=value` pairs into a record; a key is given once. */
export function parseParamFlags(pairs: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`--param expects key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    if (Object.hasOwn(params, key)) throw new UsageError(`--param ${key} was given more than once`);
    params[key] = pair.slice(eq + 1);
  }
  return params;
}

/**
 * The parameters an intent is invoked with: the `--param` pairs, checked
 * against what the intent declares, and the person's free text (words after
 * the intent, then piped stdin) as the intent's one `text` parameter.
 */
export function buildIntentParams(
  decl: ClientIntentDecl,
  input: { flagParams: Record<string, string>; words: readonly string[]; stdin: string | null }
): Record<string, string> {
  const declared = decl.params ?? {};
  for (const key of Object.keys(input.flagParams)) {
    if (!Object.hasOwn(declared, key)) {
      const known = Object.keys(declared);
      throw new UsageError(
        `Intent ${decl.name} has no parameter "${key}"` +
          (known.length ? ` (it takes: ${known.join(", ")}).` : " (it takes none).")
      );
    }
  }
  const params = { ...input.flagParams };
  const pieces = [input.words.join(" "), input.stdin?.replace(/\n$/u, "") ?? ""].filter(
    (piece) => piece.length > 0
  );
  if (pieces.length === 0) return params;
  const textParams = Object.entries(declared)
    .filter(([, type]) => type === "text")
    .map(([key]) => key);
  if (textParams.length !== 1) {
    throw new UsageError(
      textParams.length === 0
        ? `Intent ${decl.name} takes no text; remove the extra words and piped input, or pass --param.`
        : `Intent ${decl.name} has several text parameters (${textParams.join(", ")}); pass each with --param key=value.`
    );
  }
  const key = textParams[0]!;
  if (Object.hasOwn(params, key)) {
    throw new UsageError(`Parameter "${key}" was given with --param and as text; use one.`);
  }
  params[key] = pieces.join("\n\n");
  return params;
}

export interface BackgroundIntentRun {
  call: Call;
  descriptor: HostDescriptor;
  clientId: string;
  decl: ClientIntentDecl;
  params: Record<string, string>;
  stdout: Pick<NodeJS.WriteStream, "write">;
}

/**
 * Run a background intent server-side (§4.7.2) and render its declared result
 * on stdout. No client module is fetched, imported or run.
 */
export async function runBackgroundIntent(run: BackgroundIntentRun): Promise<void> {
  const result = await invokeBackgroundIntent(run.call, run.descriptor, {
    id: run.clientId,
    intent: run.decl.name,
    params: run.params,
  });
  const { text } = result;
  run.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
}
