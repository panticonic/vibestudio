import { describe, expect, it, vi } from "vitest";

import { PageImpl } from "./pageImpl";

describe("PageImpl CDP-direct compatibility helpers", () => {
  it("exposes Playwright-style locator helpers", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("querySelectorAll")) return 2;
      if (expression.includes("innerText")) return "Hello";
      if (expression.includes("textContent")) return "Hello text";
      return undefined;
    });
    const page = createPage(evaluate);
    vi.spyOn(page, "waitForSelector").mockResolvedValue(true);
    const locator = page.locator("body");

    await expect(locator.count()).resolves.toBe(2);
    await expect(locator.innerText()).resolves.toBe("Hello");
    await expect(locator.textContent()).resolves.toBe("Hello text");
  });

  it("waits for load state using the current ready state when possible", async () => {
    const evaluate = vi.fn(async () => "complete");
    const page = createPage(evaluate);

    await expect(page.waitForLoadState("load")).resolves.toBeUndefined();
  });
});

function createPage(evaluate: ReturnType<typeof vi.fn>): PageImpl {
  const session = {
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  };
  return new PageImpl(
    {} as never,
    { evaluate, getSession: () => session } as never,
    "target-1",
    session as never
  );
}
