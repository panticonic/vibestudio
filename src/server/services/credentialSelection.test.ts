import type { Credential } from "@vibestudio/credential-client/types";
import { describe, expect, it } from "vitest";
import { assertCredentialLabelAvailable, resolveCredentialByLabel } from "./credentialSelection.js";

function credential(
  id: string,
  label: string,
  url = "https://git.example.test/acme/repo.git"
): Credential {
  return {
    id,
    label,
    providerId: "url-bound",
    connectionId: id,
    connectionLabel: label,
    accountIdentity: { providerUserId: id },
    accessToken: "secret",
    scopes: [],
    bindings: [
      {
        id: "git-http",
        use: "git-http",
        audience: [{ url, match: "path-prefix" }],
        injection: {
          type: "basic-auth",
          usernameTemplate: "git",
          passwordTemplate: "{token}",
        },
      },
    ],
  };
}

describe("profile credential selection", () => {
  it("resolves a unique label only inside its URL and use boundary", async () => {
    const selected = credential("credential-1", "work");
    const store = { listUrlBound: () => [selected] };

    await expect(
      resolveCredentialByLabel(store, {
        label: "work",
        url: "https://git.example.test/acme/repo.git/info/refs",
        use: "git-http",
      })
    ).resolves.toBe(selected);
    await expect(
      resolveCredentialByLabel(store, {
        label: "work",
        url: "https://git.example.test/other/repo.git",
        use: "git-http",
      })
    ).resolves.toBeNull();
  });

  it("fails closed on duplicate active labels", async () => {
    const store = {
      listUrlBound: () => [credential("credential-1", "work"), credential("credential-2", "work")],
    };
    await expect(
      resolveCredentialByLabel(store, {
        label: "work",
        url: "https://git.example.test/acme/repo.git",
        use: "git-http",
      })
    ).rejects.toThrow("is not unique");
    await expect(assertCredentialLabelAvailable(store, { label: "work" })).rejects.toThrow(
      "already in use"
    );
  });

  it("allows a credential replacement to retain its label", async () => {
    const store = { listUrlBound: () => [credential("credential-1", "work")] };
    await expect(
      assertCredentialLabelAvailable(store, {
        label: "work",
        replacingCredentialId: "credential-1",
      })
    ).resolves.toBeUndefined();
  });
});
