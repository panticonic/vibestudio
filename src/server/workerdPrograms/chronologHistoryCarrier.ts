/** The native workspace directory calls this only after authenticating the peer and publication. */
export function chronologHistoryCarrier({
  gatewayUrl,
  token,
}: {
  gatewayUrl: string;
  token: string;
}) {
  return async ({
    peer,
    proof,
    kind,
    bytes,
    digest,
  }: {
    peer: string;
    proof: {
      signature: string;
      payload: {
        previousHead: string;
        proposedHead: string;
        applicationId: string;
        publisherPublicKey: string;
      };
    };
    kind: "grant" | "push" | "missing" | "blob" | "publish";
    digest?: string;
    bytes: number;
  }) => {
    const encoded = new TextEncoder().encode(proof.signature);
    const identity = await crypto.subtle.digest("SHA-256", encoded);
    const publicationId = Array.from(new Uint8Array(identity), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const url = new URL("/_chronolog-history", gatewayUrl);
    url.search = new URLSearchParams({
      publicationId,
      sourceNodeId: peer,
      previousHead: proof.payload.previousHead,
      proposedHead: proof.payload.proposedHead,
    }).toString();
    const request = async (method: string, body?: Uint8Array) => {
      const response = await fetch(url, {
        method,
        headers: {
          "x-chronolog-node-token": token,
          "x-chronolog-history-operation": kind,
          "x-chronolog-group": proof.payload.applicationId,
          "x-chronolog-publisher": proof.payload.publisherPublicKey,
          ...(kind === "publish" ? { "x-chronolog-proof": JSON.stringify(proof) } : {}),
          ...(digest !== undefined ? { "x-chronolog-content-digest": digest } : {}),
          ...(body ? { "content-type": "application/octet-stream" } : {}),
          "x-chronolog-packet-bytes": String(bytes),
        },
        ...(body ? { body: body as BodyInit } : {}),
      });
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error("CELLD_WORKSPACE_HISTORY_STAGE_REFUSED");
      }
      return response;
    };
    if (kind === "push" || kind === "blob") await request("HEAD");
    return {
      grant: async () => (await request("PUT")).json(),
      missing: async (): Promise<string[]> => (await request("GET")).json(),
      publish: async (): Promise<string> => (await request("PUT")).json(),
      blob: async (_digest: string, blob: Uint8Array) => {
        await request("POST", blob);
      },
      push: async (pack: Uint8Array) =>
        new Uint8Array(await (await request("POST", pack)).arrayBuffer()),
    };
  };
}
