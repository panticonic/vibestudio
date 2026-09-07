import {
  authenticatedCaller,
  envelopeFromMessage,
  originOfEnvelope,
  responseEnvelopeFor,
  retargetEnvelope,
  stampEnvelopeCaller,
} from "./envelope.js";

describe("envelope helpers", () => {
  it("creates an envelope with caller provenance when none is provided", () => {
    const envelope = envelopeFromMessage({
      selfId: "a",
      from: "panel:1",
      target: "worker:1",
      callerKind: "panel",
      message: { type: "event", fromId: "panel:1", event: "ready", payload: null },
    });

    expect(envelope.delivery.caller).toEqual({ callerId: "panel:1", callerKind: "panel" });
    expect(envelope.provenance).toEqual([{ callerId: "panel:1", callerKind: "panel" }]);
    expect(originOfEnvelope(envelope)).toEqual({ callerId: "panel:1", callerKind: "panel" });
  });

  it("preserves forwarded provenance and delivery metadata", () => {
    const origin = authenticatedCaller("panel:1", "panel");
    const envelope = envelopeFromMessage({
      selfId: "worker:1",
      from: "worker:1",
      target: "do:store:Bucket:key",
      callerKind: "worker",
      provenance: [origin, authenticatedCaller("worker:1", "worker")],
      idempotencyKey: "idem-1",
      readOnly: true,
      message: { type: "request", requestId: "r1", fromId: "worker:1", method: "save", args: [] },
    });

    expect(envelope.provenance[0]).toBe(origin);
    expect(envelope.delivery.idempotencyKey).toBe("idem-1");
    expect(envelope.delivery.readOnly).toBe(true);
    expect(originOfEnvelope(envelope)).toBe(origin);
  });

  it("retargets and creates response envelopes without changing provenance", () => {
    const request = envelopeFromMessage({
      selfId: "panel:1",
      from: "panel:1",
      target: "worker:1",
      callerKind: "panel",
      message: { type: "request", requestId: "r1", fromId: "panel:1", method: "ping", args: [] },
    });

    expect(retargetEnvelope(request, "worker:2").target).toBe("worker:2");
    const response = responseEnvelopeFor(request, authenticatedCaller("worker:1", "worker"), {
      type: "response",
      requestId: "r1",
      result: "pong",
    });

    expect(response.from).toBe("worker:1");
    expect(response.target).toBe("panel:1");
    expect(response.provenance).toBe(request.provenance);
  });

  it("stamps caller identity while preserving payload and delivery options", () => {
    const forged = envelopeFromMessage({
      selfId: "panel:forged",
      from: "panel:forged",
      target: "main",
      callerKind: "panel",
      idempotencyKey: "idem-1",
      readOnly: true,
      message: {
        type: "request",
        requestId: "r1",
        fromId: "panel:forged",
        method: "workspace.getInfo",
        args: [],
      },
    });

    const stamped = stampEnvelopeCaller(forged, authenticatedCaller("panel:runtime", "panel"));

    expect(stamped.from).toBe("panel:runtime");
    expect(stamped.target).toBe("main");
    expect(stamped.delivery).toEqual({
      caller: { callerId: "panel:runtime", callerKind: "panel" },
      idempotencyKey: "idem-1",
      readOnly: true,
    });
    expect(stamped.provenance).toEqual([{ callerId: "panel:runtime", callerKind: "panel" }]);
    expect(stamped.message).toEqual({
      type: "request",
      requestId: "r1",
      fromId: "panel:runtime",
      method: "workspace.getInfo",
      args: [],
    });
  });

  it("keeps destination addressing caller-controlled while replacing claimed origin workspace", () => {
    const forged = envelopeFromMessage({
      selfId: "worker:forged",
      from: "worker:forged",
      target: "worker:receiver",
      destination: { kind: "workspace", workspaceId: "workspace:destination" },
      caller: authenticatedCaller("worker:forged", "worker", "workspace:claimed-origin"),
      message: {
        type: "event",
        fromId: "worker:forged",
        event: "notice",
        payload: null,
      },
    });

    const stamped = stampEnvelopeCaller(
      forged,
      authenticatedCaller("worker:actual", "worker", "workspace:verified-origin")
    );

    expect(stamped.destination).toEqual({
      kind: "workspace",
      workspaceId: "workspace:destination",
    });
    expect(stamped.delivery.caller.workspaceId).toBe("workspace:verified-origin");
    expect(stamped.provenance).toEqual([
      {
        callerId: "worker:actual",
        callerKind: "worker",
        workspaceId: "workspace:verified-origin",
      },
    ]);
    expect(JSON.stringify(stamped)).not.toContain("workspace:claimed-origin");
  });

  it("addresses bounded replies back to the authenticated origin workspace", () => {
    const request = envelopeFromMessage({
      selfId: "worker:sender",
      from: "worker:sender",
      target: "worker:receiver",
      destination: { kind: "workspace", workspaceId: "workspace:destination" },
      caller: authenticatedCaller("worker:sender", "worker", "workspace:origin"),
      message: {
        type: "request",
        requestId: "r-workspace",
        fromId: "worker:sender",
        method: "ping",
        args: [],
      },
    });

    const response = responseEnvelopeFor(
      request,
      authenticatedCaller("worker:receiver", "worker", "workspace:destination"),
      { type: "response", requestId: "r-workspace", result: "pong" }
    );

    expect(response.target).toBe("worker:sender");
    expect(response.destination).toEqual({ kind: "workspace", workspaceId: "workspace:origin" });
    expect(response.delivery.caller.workspaceId).toBe("workspace:destination");
  });

  it("refuses an unbounded reply when an explicit request lacks authenticated origin", () => {
    const request = envelopeFromMessage({
      selfId: "worker:sender",
      from: "worker:sender",
      target: "worker:receiver",
      destination: { kind: "workspace", workspaceId: "workspace:destination" },
      message: {
        type: "request",
        requestId: "r-unattributed",
        fromId: "worker:sender",
        method: "ping",
        args: [],
      },
    });

    expect(() =>
      responseEnvelopeFor(
        request,
        authenticatedCaller("worker:receiver", "worker", "workspace:destination"),
        { type: "response", requestId: "r-unattributed", result: "pong" }
      )
    ).toThrow(/authenticated origin workspace/);
  });
});
