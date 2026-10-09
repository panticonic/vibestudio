/**
 * Host-observed transport evidence for a panel document's boot.
 *
 * The bootstrap's `<script type=module>` `onerror` cannot tell why its module
 * graph failed to load: a 404 and a request Chromium aborted mid-flight look
 * identical from inside the page. The host can tell — it observes the network
 * stack's own failure for each of the document's script requests (CDP
 * `Network.loadingFailed` headless, `webRequest.onErrorOccurred` on desktop).
 * This module is the one policy both hosts apply to that evidence:
 *
 *  - Classification: a `bundle-load` boot failure whose document lost a script
 *    request to a transport error carries that error, so it is reported as the
 *    transport failure it is instead of a defect in the panel's code.
 *  - Recovery: Chromium aborts every in-flight request — loopback included —
 *    with `ERR_NETWORK_CHANGED` whenever any host IP address changes, and
 *    exposes no switch to exempt loopback. A load lost to that event is an
 *    idempotent load of immutable content that the network changed under, so
 *    the host reloads it once for that observed failure. Every reload is
 *    caused by a distinct observed failure of a distinct document; any other
 *    failure propagates unchanged.
 */
import type { PanelBootProbeResult, PanelBootTransportFailure } from "./observation.js";

export type { PanelBootTransportFailure } from "./observation.js";

const NETWORK_CHANGED = "ERR_NETWORK_CHANGED";

function netErrorName(netError: string): string {
  return netError.startsWith("net::") ? netError.slice("net::".length) : netError;
}

/** Chromium aborted this load because a host IP address changed under it. */
export function isNetworkChangeAbort(netError: string): boolean {
  return netErrorName(netError) === NETWORK_CHANGED;
}

/**
 * Whether a network-stack error is a transport failure of the request rather
 * than a cancellation (a superseded load) or a client policy block.
 */
export function isTransportNetError(netError: string): boolean {
  const name = netErrorName(netError);
  return name !== "ERR_ABORTED" && !name.startsWith("ERR_BLOCKED_BY_");
}

/**
 * Attach the document's observed transport failure to a `bundle-load` boot
 * failure. Every other observation is returned unchanged.
 */
export function classifyPanelBootTransport(
  boot: PanelBootProbeResult,
  failures: readonly PanelBootTransportFailure[]
): { boot: PanelBootProbeResult; networkChanged: boolean } {
  if (
    boot.kind !== "observed" ||
    boot.observation.phase !== "failed" ||
    boot.observation.failureStage !== "bundle-load" ||
    failures.length === 0
  ) {
    return { boot, networkChanged: false };
  }
  const cause = failures.find((failure) => isNetworkChangeAbort(failure.netError)) ?? failures[0]!;
  return {
    boot: { kind: "observed", observation: { ...boot.observation, transportFailure: cause } },
    networkChanged: isNetworkChangeAbort(cause.netError),
  };
}

/**
 * Per-view ledger of the current document's script transport failures, and the
 * single observation path through which a host reads that document's boot.
 */
export class PanelDocumentBootTransport {
  private failures: PanelBootTransportFailure[] = [];
  private generation = 0;
  /** The reload answering the failed document of `generation`, if any. */
  private recovery: { generation: number; reload: Promise<unknown> } | null = null;

  /** A new main-frame document committed; prior evidence belongs to the old one. */
  documentCommitted(): void {
    this.generation += 1;
    this.failures = [];
    this.recovery = null;
  }

  /** The network stack failed one of the current document's script requests. */
  scriptRequestFailed(failure: PanelBootTransportFailure): void {
    if (isTransportNetError(failure.netError)) this.failures.push(failure);
  }

  /**
   * Observe the current document's boot. A `bundle-load` failure caused by a
   * network change is answered by reloading that document — once, shared by
   * every concurrent observer — and observing its replacement. A reload that
   * fails rejects with its own error; one that does not replace the document
   * leaves the classified failure to propagate.
   */
  async observe(
    probe: () => Promise<PanelBootProbeResult>,
    reload: () => Promise<unknown>
  ): Promise<PanelBootProbeResult> {
    for (;;) {
      const generation = this.generation;
      const probed = await probe();
      // The probe answered for a document that has since been replaced; its
      // evidence and this ledger no longer describe the same document.
      if (generation !== this.generation) continue;
      const { boot, networkChanged } = classifyPanelBootTransport(probed, this.failures);
      if (!networkChanged) return boot;
      let recovery = this.recovery;
      if (recovery?.generation !== generation) {
        recovery = { generation, reload: reload() };
        this.recovery = recovery;
      }
      await recovery.reload;
      if (generation === this.generation) return boot;
    }
  }
}
