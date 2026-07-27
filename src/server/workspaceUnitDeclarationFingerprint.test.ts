import { describe, expect, it } from "vitest";
import {
  AppliedWorkspaceUnitDeclarations,
  workspaceUnitDeclarationFingerprint,
} from "./workspaceUnitDeclarationFingerprint";

describe("workspaceUnitDeclarationFingerprint", () => {
  it("is insensitive to object property order and omitted undefined values", () => {
    expect(
      workspaceUnitDeclarationFingerprint([
        { source: "extensions/git-bridge", eager: true, optional: undefined },
      ])
    ).toBe(workspaceUnitDeclarationFingerprint([{ eager: true, source: "extensions/git-bridge" }]));
  });

  it("changes when declaration meaning changes", () => {
    expect(
      workspaceUnitDeclarationFingerprint([{ source: "extensions/git-bridge", eager: true }])
    ).not.toBe(
      workspaceUnitDeclarationFingerprint([{ source: "extensions/git-bridge", eager: false }])
    );
  });

  it("preserves declaration order", () => {
    const first = { source: "extensions/first" };
    const second = { source: "extensions/second" };
    expect(workspaceUnitDeclarationFingerprint([first, second])).not.toBe(
      workspaceUnitDeclarationFingerprint([second, first])
    );
  });
});

describe("AppliedWorkspaceUnitDeclarations", () => {
  it("retains the applied fingerprint until a declaration operation succeeds", async () => {
    const applied = new AppliedWorkspaceUnitDeclarations();

    await applied.apply("current", () => undefined);
    await expect(
      applied.apply("candidate", () => Promise.reject(new Error("reconcile failed")))
    ).rejects.toThrow("reconcile failed");
    expect(applied.matches("current")).toBe(true);
    expect(applied.matches("candidate")).toBe(false);

    await applied.apply("candidate", () => undefined);
    expect(applied.matches("candidate")).toBe(true);
  });

  it("does not let an older completion replace a newer applied fingerprint", async () => {
    const applied = new AppliedWorkspaceUnitDeclarations();
    let finishOlder!: () => void;
    const older = applied.apply(
      "older",
      () =>
        new Promise<void>((resolve) => {
          finishOlder = resolve;
        })
    );

    await applied.apply("newer", () => undefined);
    finishOlder();
    await older;

    expect(applied.matches("newer")).toBe(true);
    expect(applied.matches("older")).toBe(false);
  });
});
