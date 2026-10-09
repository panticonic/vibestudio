import { describe, expect, it, vi } from "vitest";
import {
  classifyPanelBootTransport,
  isNetworkChangeAbort,
  isTransportNetError,
  PanelDocumentBootTransport,
} from "./bootTransport.js";
import type { PanelBootProbeResult } from "./observation.js";

const bundleLoadFailed: PanelBootProbeResult = {
  kind: "observed",
  observation: {
    phase: "failed",
    failureStage: "bundle-load",
    message: "The panel bundle could not be loaded",
  },
};
const booting: PanelBootProbeResult = { kind: "observed", observation: { phase: "booting" } };
const chunk = "http://127.0.0.1:4000/panels/chat/chunk-a.js";

describe("panel boot transport policy", () => {
  it("recognizes network-change aborts and transport errors from every host's spelling", () => {
    expect(isNetworkChangeAbort("net::ERR_NETWORK_CHANGED")).toBe(true);
    expect(isNetworkChangeAbort("ERR_NETWORK_CHANGED")).toBe(true);
    expect(isNetworkChangeAbort("net::ERR_CONNECTION_RESET")).toBe(false);
    expect(isTransportNetError("net::ERR_CONNECTION_REFUSED")).toBe(true);
    expect(isTransportNetError("net::ERR_ABORTED")).toBe(false);
    expect(isTransportNetError("net::ERR_BLOCKED_BY_CLIENT")).toBe(false);
  });

  it("attaches observed transport evidence only to bundle-load failures", () => {
    const failure = { url: chunk, netError: "net::ERR_CONNECTION_RESET" };
    expect(classifyPanelBootTransport(bundleLoadFailed, [failure])).toEqual({
      boot: {
        kind: "observed",
        observation: { ...bundleLoadFailed.observation, transportFailure: failure },
      },
      networkChanged: false,
    });
    // No network failure observed: a 404 or MIME failure stays a bundle failure.
    expect(classifyPanelBootTransport(bundleLoadFailed, [])).toEqual({
      boot: bundleLoadFailed,
      networkChanged: false,
    });
    const entryThrew: PanelBootProbeResult = {
      kind: "observed",
      observation: { phase: "failed", failureStage: "entry", message: "boom" },
    };
    expect(classifyPanelBootTransport(entryThrew, [failure]).boot).toBe(entryThrew);
  });

  it("prefers the network-change abort as the cause", () => {
    const result = classifyPanelBootTransport(bundleLoadFailed, [
      { url: `${chunk}?a`, netError: "net::ERR_CONNECTION_RESET" },
      { url: chunk, netError: "net::ERR_NETWORK_CHANGED" },
    ]);
    expect(result.networkChanged).toBe(true);
    expect(result.boot).toMatchObject({
      observation: { transportFailure: { url: chunk, netError: "net::ERR_NETWORK_CHANGED" } },
    });
  });
});

describe("PanelDocumentBootTransport", () => {
  it("reloads a document whose boot lost a script to a network change, once, and observes its replacement", async () => {
    const ledger = new PanelDocumentBootTransport();
    ledger.scriptRequestFailed({ url: chunk, netError: "net::ERR_NETWORK_CHANGED" });
    const probe = vi
      .fn<() => Promise<PanelBootProbeResult>>()
      .mockResolvedValueOnce(bundleLoadFailed)
      .mockResolvedValueOnce(bundleLoadFailed)
      .mockResolvedValue(booting);
    let finishReload!: () => void;
    const reload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishReload = () => {
            ledger.documentCommitted();
            resolve();
          };
        })
    );

    // Two concurrent observers of the failed document share one reload.
    const first = ledger.observe(probe, reload);
    const second = ledger.observe(probe, reload);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    finishReload();
    await expect(first).resolves.toEqual(booting);
    await expect(second).resolves.toEqual(booting);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("gives each distinct network-change failure its own reload", async () => {
    const ledger = new PanelDocumentBootTransport();
    let documents = 0;
    const reload = vi.fn(async () => {
      ledger.documentCommitted();
      documents += 1;
      // The replacement document loses its own script to a second change.
      if (documents === 1) {
        ledger.scriptRequestFailed({ url: chunk, netError: "net::ERR_NETWORK_CHANGED" });
      }
    });
    ledger.scriptRequestFailed({ url: chunk, netError: "net::ERR_NETWORK_CHANGED" });
    const probe = vi.fn(async () => (documents < 2 ? bundleLoadFailed : booting));
    await expect(ledger.observe(probe, reload)).resolves.toEqual(booting);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("propagates other failures unchanged and never reloads for them", async () => {
    const ledger = new PanelDocumentBootTransport();
    const reload = vi.fn(async () => undefined);
    await expect(ledger.observe(async () => bundleLoadFailed, reload)).resolves.toEqual(
      bundleLoadFailed
    );
    ledger.scriptRequestFailed({ url: chunk, netError: "net::ERR_CONNECTION_REFUSED" });
    await expect(ledger.observe(async () => bundleLoadFailed, reload)).resolves.toMatchObject({
      observation: { transportFailure: { netError: "net::ERR_CONNECTION_REFUSED" } },
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("reports the classified failure when the reload does not replace the document", async () => {
    const ledger = new PanelDocumentBootTransport();
    ledger.scriptRequestFailed({ url: chunk, netError: "net::ERR_NETWORK_CHANGED" });
    const reload = vi.fn(async () => undefined);
    const result = await ledger.observe(async () => bundleLoadFailed, reload);
    expect(result).toMatchObject({
      observation: { transportFailure: { netError: "net::ERR_NETWORK_CHANGED" } },
    });
    await ledger.observe(async () => bundleLoadFailed, reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed reload to every observer", async () => {
    const ledger = new PanelDocumentBootTransport();
    ledger.scriptRequestFailed({ url: chunk, netError: "net::ERR_NETWORK_CHANGED" });
    const failure = new Error("panel reload failed: net::ERR_CONNECTION_REFUSED");
    const reload = vi.fn(async () => {
      throw failure;
    });
    await expect(ledger.observe(async () => bundleLoadFailed, reload)).rejects.toBe(failure);
    await expect(ledger.observe(async () => bundleLoadFailed, reload)).rejects.toBe(failure);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores cancellations and forgets evidence when a new document commits", async () => {
    const ledger = new PanelDocumentBootTransport();
    ledger.scriptRequestFailed({ url: chunk, netError: "net::ERR_ABORTED" });
    const reload = vi.fn(async () => undefined);
    await expect(ledger.observe(async () => bundleLoadFailed, reload)).resolves.toEqual(
      bundleLoadFailed
    );
    ledger.scriptRequestFailed({ url: chunk, netError: "net::ERR_NETWORK_CHANGED" });
    ledger.documentCommitted();
    await expect(ledger.observe(async () => bundleLoadFailed, reload)).resolves.toEqual(
      bundleLoadFailed
    );
    expect(reload).not.toHaveBeenCalled();
  });
});
