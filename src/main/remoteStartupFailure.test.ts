import { describe, expect, it } from "vitest";
import { remoteStartupFailurePresentation } from "./remoteStartupFailure.js";

describe("remoteStartupFailurePresentation", () => {
  it("says when a local preflight failure leaves the same link reusable", () => {
    expect(
      remoteStartupFailurePresentation(
        new Error("Secure storage is unavailable. The pairing link was not used."),
        true
      )
    ).toMatchObject({
      detail: expect.stringMatching(/retry the same pairing link.*not consumed/is),
    });
  });

  it("explains the replay protection and fresh-link recovery for a consumed link", () => {
    expect(
      remoteStartupFailurePresentation(
        new Error("This pairing link has already been used or has expired."),
        true
      )
    ).toMatchObject({ detail: expect.stringMatching(/single-use.*prevent replay.*fresh link/is) });
  });

  it("does not claim an ambiguous fresh-pairing failure preserved the link", () => {
    expect(remoteStartupFailurePresentation(new Error("Connection lost"), true).detail).toMatch(
      /if the error says.*not used.*otherwise generate a fresh link/i
    );
  });

  it("keeps returning-device recovery separate from one-time pairing", () => {
    expect(remoteStartupFailurePresentation(new Error("Connection lost"), false).detail).toMatch(
      /saved pairing was kept/i
    );
  });
});
