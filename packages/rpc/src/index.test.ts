import { describe, expect, it } from "vitest";
import * as publicRpc from "./index.js";

describe("@vibestudio/rpc public authority surface", () => {
  it("does not export direct-attestation transport internals", () => {
    expect(publicRpc).not.toHaveProperty("DIRECT_AUTHORITY_ACCEPTED_AT_HEADER");
    expect(publicRpc).not.toHaveProperty("createInternalRpcClient");
    expect(publicRpc).not.toHaveProperty("createInternalConnectionlessRpcClient");
  });
});
