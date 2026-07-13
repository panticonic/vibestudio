import { describe, expect, it } from "vitest";
import { renderApiKeyMaterialTemplate, validateApiKeyMaterialTemplate } from "./apiKey.js";

describe("API-key material templates", () => {
  it("validates declared placeholders and renders trimmed field values", () => {
    expect(() =>
      validateApiKeyMaterialTemplate("{username}:{token}", ["username", "token"])
    ).not.toThrow();
    expect(
      renderApiKeyMaterialTemplate("{username}:{token}", {
        username: " alice ",
        token: " secret ",
      })
    ).toBe("alice:secret");
  });

  it("rejects empty and undeclared templates with a structured connection error", () => {
    expect(() => validateApiKeyMaterialTemplate("literal", ["token"])).toThrow(
      expect.objectContaining({ code: "invalid_connection_spec" })
    );
    expect(() => validateApiKeyMaterialTemplate("{missing}", ["token"])).toThrow(
      expect.objectContaining({
        code: "invalid_connection_spec",
        message: "api-key materialTemplate references undeclared field: missing",
      })
    );
  });
});
