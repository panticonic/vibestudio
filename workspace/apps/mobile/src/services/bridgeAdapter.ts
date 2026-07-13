import type { PanelManager } from "@vibestudio/shell-core/panelManager";
import { asPanelSlotId, type PanelEntityId } from "@vibestudio/shared/panel/ids";
import type { OpenExternalOptions } from "@vibestudio/shared/externalOpen";
import { externalOpenMethods } from "@vibestudio/service-schemas/externalOpen";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  createBridgeStreamRelay,
  stampEnvelopeCaller,
  type BridgeBodyChunk,
  type BridgeStreamOpen,
  type BridgeStreamRelay,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import type { WebRtcSession } from "@vibestudio/rpc/transports/webrtcClient";
import type { MobileRpcClient } from "./mobileTransport";

export interface BridgeAdapterCallbacks {
  navigateToPanel(panelId: string): void;
}

type PanelLease = { runtimeEntityId: PanelEntityId; connectionId: string };

type PanelSessionEntry = {
  session: WebRtcSession;
  leaseKey: string;
};

export function createBridgeAdapter(deps: {
  panelManager: PanelManager;
  transport: MobileRpcClient;
  callbacks: BridgeAdapterCallbacks;
  getPanelInit?: (panelId: string) => Promise<unknown>;
  /** Push an inbound RPC envelope into a panel's webview (host → panel). */
  deliverToPanel: (panelId: string, envelope: unknown) => void;
  /**
   * The panel's runtime lease — entity id (the server's panel principal + lease
   * key) and the lease's connectionId. The panel session must redeem a grant for
   * the entity id and open on that exact connectionId so authorizePanelConnection
   * matches; undefined until the panel has been materialized (lease acquired).
   */
  getPanelLease: (panelId: string) => PanelLease | undefined;
}) {
  // Tree mutations from hosted webviews route through the single server
  // authority (panelTree); the mirror updates reactively via the broadcast.
  const callPanelTree = <T = unknown>(method: string, callArgs: unknown[]): Promise<T> =>
    deps.transport.call("main", `panelTree.${method}`, callArgs) as Promise<T>;

  // Panel RPC relay. A panel's RpcClient rides this postMessage bridge: it sends
  // RPC envelopes via `postEnvelope` and receives them via `onEnvelope` (delivered
  // by `deliverToPanel`). Each panel gets its OWN grant-authenticated "panel"
  // session over the pipe, and we relay its envelopes TRANSPARENTLY over that
  // dedicated session (send out; the session's onMessage → deliverToPanel). The
  // server attributes by the authenticated session, so the panel's calls carry the
  // "panel" principal that capability-gated services (e.g. PubSub `subscribe`)
  // require — NOT "shell". Because the session is dedicated to this panel, replies,
  // events and stream frames demux straight back to it with no shared-session
  // ambiguity, and all RpcMessage types relay without per-type handling.
  const panelSessions = new Map<string, Promise<PanelSessionEntry>>();

  function requirePanelLease(panelId: string): PanelLease {
    const lease = deps.getPanelLease(panelId);
    if (!lease) {
      throw new Error(`Panel ${panelId} has no runtime lease yet — cannot open panel session`);
    }
    return lease;
  }

  function ensurePanelSession(panelId: string): Promise<WebRtcSession> {
    let lease: PanelLease;
    try {
      lease = requirePanelLease(panelId);
    } catch (err) {
      closePanelSession(panelId);
      return Promise.reject(err);
    }
    const expectedLeaseKey = panelLeaseKey(lease);
    const existing = panelSessions.get(panelId);
    if (existing) {
      return existing.then(
        (entry) => {
          if (entry.leaseKey === expectedLeaseKey && isPanelSessionLive(entry.session)) {
            return entry.session;
          }
          if (panelSessions.get(panelId) === existing) panelSessions.delete(panelId);
          entry.session.close();
          return ensurePanelSession(panelId);
        },
        (error) => {
          if (panelSessions.get(panelId) === existing) panelSessions.delete(panelId);
          throw error;
        }
      );
    }

    const pending = openPanelSessionEntry(panelId, lease);
    panelSessions.set(panelId, pending);
    // Drop a failed open so a later postEnvelope retries instead of reusing the
    // cached rejection.
    pending.catch(() => {
      if (panelSessions.get(panelId) === pending) panelSessions.delete(panelId);
    });
    return pending.then((entry) => entry.session);
  }

  async function openPanelSessionEntry(
    panelId: string,
    lease: PanelLease
  ): Promise<PanelSessionEntry> {
    const session = await deps.transport.openPanelSession(
      lease.runtimeEntityId,
      lease.connectionId
    );
    session.onMessage((envelope) => deps.deliverToPanel(panelId, envelope));
    return { session, leaseKey: panelLeaseKey(lease) };
  }

  // §1.6 upload relays, one per panel (see @vibestudio/rpc bridgeStream.ts). The
  // RN postMessage bridge is string-only, so chunks cross as base64 (~256 KiB);
  // the relay reassembles the request body (8 MiB cap, fail-loud) and feeds the
  // panel's WebRTC session streamReadable(). Response head/chunks/end go back
  // through deliverToPanel tagged `__vibestudioBridgeStream` (the injected bootstrap
  // demuxes them off the envelope path), ack-gated so the webview buffer stays
  // bounded.
  const streamRelays = new Map<string, BridgeStreamRelay>();

  function closePanelSession(panelId: string): void {
    const relay = streamRelays.get(panelId);
    if (relay) {
      streamRelays.delete(panelId);
      relay.destroy(`panel ${panelId} session closed`);
    }
    const pending = panelSessions.get(panelId);
    if (!pending) return;
    panelSessions.delete(panelId);
    void pending.then((entry) => entry.session.close()).catch(() => {});
  }

  function ensureStreamRelay(panelId: string): BridgeStreamRelay {
    const existing = streamRelays.get(panelId);
    if (existing) return existing;
    const relay = createBridgeStreamRelay({
      chunkFormat: "base64",
      openStream: async (envelope, signal, body) => {
        const session = await ensurePanelSession(panelId);
        const lease = requirePanelLease(panelId);
        if (typeof session.streamReadable !== "function") {
          throw new Error(
            "Streaming request bodies (uploads) require the WebRTC transport; " +
              "this panel's host session cannot stream a request body"
          );
        }
        return session.streamReadable(
          stampEnvelopeCaller(envelope, { callerId: lease.runtimeEntityId, callerKind: "panel" }),
          signal,
          body
        );
      },
      sendToPanel: (msg) => deps.deliverToPanel(panelId, { __vibestudioBridgeStream: true, msg }),
    });
    streamRelays.set(panelId, relay);
    return relay;
  }

  return {
    closePanelSession,
    async handle(panelId: string, method: string, args: unknown[]): Promise<unknown> {
      const slotId = asPanelSlotId(panelId);
      switch (method) {
        case "getPanelInit":
          if (deps.getPanelInit) return deps.getPanelInit(panelId);
          return deps.panelManager.getPanelInit(slotId);
        case "getInfo":
          return deps.panelManager.getInfo(slotId);
        case "focusPanel": {
          const targetId = args[0] as string;
          await deps.panelManager.notifyFocused(asPanelSlotId(targetId));
          deps.callbacks.navigateToPanel(targetId);
          return;
        }
        case "openPanelChild": {
          const [source, options] = args as [
            string,
            {
              name?: string;
              focus?: boolean;
              stateArgs?: Record<string, unknown>;
            }?,
          ];
          const created = await callPanelTree<{ id: string; title: string; kind: string }>(
            "create",
            [source, { parentId: panelId, name: options?.name, stateArgs: options?.stateArgs }]
          );
          if (options?.focus !== false) {
            deps.callbacks.navigateToPanel(created.id);
          }
          return { id: created.id, title: created.title, kind: created.kind };
        }
        case "openExternal": {
          const [url, options] = args as [string, OpenExternalOptions?];
          const externalOpen = createTypedServiceClient(
            "externalOpen",
            externalOpenMethods,
            (svc, method, callArgs) => deps.transport.call("main", `${svc}.${method}`, callArgs)
          );
          await externalOpen.openExternal(url, options);
          return;
        }
        case "getCdpEndpoint":
        case "navigate":
        case "goBack":
        case "goForward":
        case "stop":
          throw new Error(
            "CDP automation is routed through the server broker and is not available for mobile-held WebViews"
          );
        case "openDevtools":
          return;
        case "openFolderDialog":
          return null;
        case "postEnvelope": {
          // One-way send over the panel's dedicated "panel" session; replies +
          // events arrive via the session's onMessage → deliverToPanel.
          const [envelope] = args as [RpcEnvelope];
          void ensurePanelSession(panelId)
            // Return the send promise so a send rejection is caught here rather
            // than becoming an unhandled rejection (Finding 5).
            .then((session) => {
              const lease = requirePanelLease(panelId);
              return session.send(
                stampEnvelopeCaller(envelope, {
                  callerId: lease.runtimeEntityId,
                  callerKind: "panel",
                })
              );
            })
            .catch((err) =>
              console.warn(`[bridgeAdapter] postEnvelope relay failed (panel ${panelId}):`, err)
            );
          return;
        }
        // §1.6 upload hop — a panel's streaming request body crosses the
        // postMessage bridge as sequenced base64 chunk messages. Rejections
        // propagate to the panel's awaited callHost (fail-loud, no silent drop).
        case "streamOpen": {
          const [msg] = args as [BridgeStreamOpen];
          ensureStreamRelay(panelId).open(msg);
          return;
        }
        case "streamBodyChunk": {
          const [msg] = args as [BridgeBodyChunk];
          const relay = streamRelays.get(panelId);
          if (!relay) throw new Error(`No open bridge upload stream for panel ${panelId}`);
          // The returned promise IS the backpressure: it resolves (→ the panel's
          // pending callHost ack) once the reassembly buffer is under the watermark.
          return relay.pushBodyChunk(msg);
        }
        case "streamAbort": {
          const [opId] = args as [string];
          streamRelays.get(panelId)?.abort(String(opId));
          return;
        }
        case "streamAck": {
          const [opId, seq] = args as [string, number];
          streamRelays.get(panelId)?.ack(String(opId), Number(seq));
          return;
        }
        default:
          throw new Error(`Unknown mobile bridge method: ${method}`);
      }
    },
  };
}

function panelLeaseKey(lease: PanelLease): string {
  return `${lease.runtimeEntityId}\u0000${lease.connectionId}`;
}

function isPanelSessionLive(session: WebRtcSession): boolean {
  return !session.isClosed();
}
