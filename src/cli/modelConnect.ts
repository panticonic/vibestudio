import type { StoredCredentialSummary } from "@vibestudio/credential-client/types";
import {
  getProviderConnectPreset,
  listProviderConnectPresets,
  toCredentialConnectRequest,
} from "@vibestudio/shared/providerConnect";
import {
  handleExternalOpenPayload,
  type ExternalOpenPayload,
} from "../node/oauthLoopbackHandoff.js";
import { openExternalBrowser } from "../node/openExternalBrowser.js";
import { presentAuthorizeUrl, readPastedCallbackUrl } from "./manualOAuthHandoff.js";
import { UsageError } from "./output.js";
import { RpcClient, type DeviceCredential } from "./rpcClient.js";
import type { ModelConnectResult } from "./modelCommands.js";

interface ModelConnectRpc {
  onEvent(event: string, listener: (payload: unknown, fromId: string) => void): Promise<() => void>;
  callTargetPush(targetId: string, method: string, args?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface ModelConnectDependencies {
  createRpc(credentials: DeviceCredential): ModelConnectRpc;
  openExternal(url: string): Promise<unknown>;
  /** Manual mode only: show the authorize URL instead of launching a browser. */
  presentUrl?(context: { authorizeUrl: string; redirectUri: string }): void;
  /** Manual mode only: read the callback URL the operator pasted back. */
  awaitPastedCallback?(context: { authorizeUrl: string; redirectUri: string }): Promise<string>;
}

export interface ModelConnectOptions {
  /**
   * Print the authorization URL and accept a pasted callback instead of
   * opening a browser on this host. Needed whenever the operator's browser is
   * elsewhere: a headless server, an SSH session, or a second device.
   */
  manual?: boolean;
}

const DEFAULT_DEPENDENCIES: ModelConnectDependencies = {
  createRpc: (credentials) => new RpcClient(credentials),
  openExternal: openExternalBrowser,
  presentUrl: presentAuthorizeUrl,
  awaitPastedCallback: () => readPastedCallbackUrl(),
};

/**
 * Connect a provider through the existing credential coordinator. This host
 * adapter owns only browser/callback handoff; PKCE, exchange, replacement,
 * refresh material, and credential storage remain server-owned.
 */
export async function connectModelProvider(
  credentials: DeviceCredential,
  providerId: string,
  options: ModelConnectOptions = {},
  dependencies: ModelConnectDependencies = DEFAULT_DEPENDENCIES
): Promise<ModelConnectResult> {
  const preset = getProviderConnectPreset(providerId);
  if (!preset) {
    throw new UsageError(
      `unknown model provider ${JSON.stringify(providerId)}; known providers: ${listProviderConnectPresets()
        .map((entry) => entry.providerId)
        .join(", ")}`
    );
  }
  if (preset.flow.type !== "oauth2-auth-code-pkce") {
    throw new UsageError(
      `${providerId} uses API-key input, which must currently be entered in Vibestudio model settings; ` +
        "the CLI connect command supports browser OAuth providers"
    );
  }

  const manual = options.manual === true;
  if (manual && !dependencies.presentUrl) {
    throw new Error("Manual model connect needs a way to present the authorization URL");
  }

  const request = toCredentialConnectRequest(providerId, { browser: "external" });
  if (!request) throw new Error(`No credential connection preset for ${providerId}`);

  const rpc = dependencies.createRpc(credentials);
  const state: { handoff: Promise<void> | null } = { handoff: null };
  let resolveHandoff!: () => void;
  let rejectHandoff!: (reason: unknown) => void;
  const handoffCompleted = new Promise<void>((resolve, reject) => {
    resolveHandoff = resolve;
    rejectHandoff = reject;
  });
  let unsubscribe: (() => void) | null = null;
  let connect: Promise<StoredCredentialSummary> | null = null;

  try {
    // Subscription must be live before connect starts: the coordinator routes
    // the browser handoff to this exact authenticated connection.
    unsubscribe = await rpc.onEvent("external-open:open", (payload) => {
      if (state.handoff) return;
      const external = parseOAuthHandoff(payload);
      if (!external) return;
      state.handoff = handleExternalOpenPayload(external, {
        // Manual mode launches nothing here: the operator opens the URL
        // wherever their browser actually is. Presentation happens on the
        // paste route below, which receives the bound redirect too.
        openExternal: manual ? async () => undefined : dependencies.openExternal,
        forwardOAuthCallback: (callback) =>
          rpc.callTargetPush("main", "credentials.forwardOAuthCallback", [callback]),
        cancelOAuth: (transactionId) =>
          rpc.callTargetPush("main", "credentials.cancelOAuth", [{ transactionId }]),
        ...(manual
          ? {
              awaitPastedCallback: (context: { authorizeUrl: string; redirectUri: string }) => {
                dependencies.presentUrl?.(context);
                return (
                  dependencies.awaitPastedCallback?.(context) ??
                  new Promise<string>(() => undefined)
                );
              },
            }
          : {}),
      });
      state.handoff.then(resolveHandoff, rejectHandoff);
    });

    connect = rpc
      .callTargetPush("main", "credentials.connect", [request])
      .then((value) => value as StoredCredentialSummary);
    const never = new Promise<never>(() => undefined);
    const connectBeforeHandoff = connect.then(
      () => {
        if (!state.handoff) {
          throw new Error(
            "OAuth connection completed without a browser handoff on this CLI session"
          );
        }
        return never;
      },
      (error: unknown) => {
        // Once the coordinator emitted a handoff, its local listener/browser
        // result is more specific. Cancellation also rejects connect, but must
        // not replace that useful error with a generic server cancellation.
        if (!state.handoff) throw error;
        return never;
      }
    );
    await Promise.race([handoffCompleted, connectBeforeHandoff]);
    const credential = await connect;
    return publicCredentialResult(providerId, credential);
  } finally {
    // A failed handoff cancels the server transaction, which rejects connect;
    // consume that trailing rejection before tearing down the push connection.
    connect?.catch(() => undefined);
    await state.handoff?.catch(() => undefined);
    unsubscribe?.();
    await rpc.close();
  }
}

/** Accept only the OAuth loopback shape needed by this one-shot command. */
function parseOAuthHandoff(value: unknown): ExternalOpenPayload | null {
  if (!isRecord(value) || typeof value["url"] !== "string") return null;
  const loopback = value["oauthLoopback"];
  if (!isRecord(loopback)) return null;
  if (
    typeof loopback["transactionId"] !== "string" ||
    typeof loopback["redirectUri"] !== "string" ||
    (loopback["host"] !== "localhost" && loopback["host"] !== "127.0.0.1") ||
    typeof loopback["port"] !== "number" ||
    !Number.isInteger(loopback["port"]) ||
    typeof loopback["callbackPath"] !== "string" ||
    typeof loopback["state"] !== "string" ||
    typeof loopback["timeoutMs"] !== "number"
  ) {
    return null;
  }
  if (
    typeof value["callerId"] !== "string" ||
    (value["callerKind"] !== "shell" &&
      value["callerKind"] !== "app" &&
      value["callerKind"] !== "panel")
  ) {
    return null;
  }
  return value as unknown as ExternalOpenPayload;
}

function publicCredentialResult(
  providerId: string,
  value: StoredCredentialSummary
): ModelConnectResult {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["label"] !== "string" ||
    !isRecord(value["lifecycle"]) ||
    (value["lifecycle"]["state"] !== "active" &&
      value["lifecycle"]["state"] !== "expired" &&
      value["lifecycle"]["state"] !== "revoked") ||
    typeof value["lifecycle"]["canRefresh"] !== "boolean"
  ) {
    throw new Error("Credential connection returned an invalid secret-free summary");
  }
  return {
    providerId,
    credential: {
      id: value["id"],
      label: value["label"],
      lifecycle: {
        state: value["lifecycle"]["state"],
        canRefresh: value["lifecycle"]["canRefresh"],
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
