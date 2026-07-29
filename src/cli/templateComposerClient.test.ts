import { describe, expect, it, vi } from "vitest";
import {
  createTemplateComposerClient,
  TEMPLATE_COMPOSER_EXTENSION,
} from "./templateComposerClient.js";

describe("template composer CLI client", () => {
  it("forwards through the generic public extension invocation venue", async () => {
    const call = vi.fn(async () => []);
    const client = createTemplateComposerClient({ call });

    await expect(client.status()).resolves.toEqual([]);

    expect(call).toHaveBeenCalledWith("extensions.invoke", [
      TEMPLATE_COMPOSER_EXTENSION,
      "status",
      [],
    ]);
  });

  it("retains the template result schema at the userland boundary", async () => {
    const call = vi.fn(async () => ({ not: "a status list" }));
    const client = createTemplateComposerClient({ call });

    await expect(client.status()).rejects.toThrow(
      /template-composer.*status.*return value failed schema validation/
    );
  });
});
