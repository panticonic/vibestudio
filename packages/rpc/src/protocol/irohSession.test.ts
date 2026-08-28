import { IROH_WIRE_VERSION } from "@vibestudio/iroh-transport";
import { describe, expect, it } from "vitest";
import {
  decodeIrohSessionControlFrame,
  encodeIrohSessionControlFrame,
  IROH_SESSION_CLOSE,
  IROH_SESSION_HELLO,
  IROH_SESSION_OPEN,
  IROH_SESSION_OPEN_RESULT,
  type IrohSessionControlFrame,
} from "./irohSession.js";

describe("Iroh session control protocol", () => {
  it.each<IrohSessionControlFrame>([
    { t: IROH_SESSION_HELLO, protocolVersion: IROH_WIRE_VERSION, contractVersion: 3 },
    { t: IROH_SESSION_OPEN, sid: "shell", token: "pairing-token", clientPlatform: "desktop" },
    { t: IROH_SESSION_OPEN_RESULT, sid: "shell", success: true, callerId: "shell:device" },
    { t: IROH_SESSION_CLOSE, sid: "shell", code: 1000, reason: "done" },
  ])("round-trips $t", (frame) => {
    expect(decodeIrohSessionControlFrame(encodeIrohSessionControlFrame(frame))).toEqual(frame);
  });

  it.each([
    { t: "hello", protocolVersion: 3, contractVersion: 3 },
    { t: "open", sid: "shell" },
    { t: "open", sid: "", token: "token" },
    { t: "open-result", sid: "shell" },
    { t: "unknown", sid: "shell" },
  ])("rejects malformed frame %#", (frame) => {
    expect(() =>
      decodeIrohSessionControlFrame(new TextEncoder().encode(JSON.stringify(frame)))
    ).toThrow();
  });
});
