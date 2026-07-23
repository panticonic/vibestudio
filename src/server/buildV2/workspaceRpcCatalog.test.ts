import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { collectWorkspaceRpcCatalog } from "./workspaceRpcCatalog.js";

describe("workspace RPC build catalog", () => {
  it("derives documented receiver methods from the exact worker source", () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-rpc-catalog-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(
      join(root, "nested", "provider.ts"),
      `
        class NotesDO {
          /** Return one note without changing it. */
          @rpc({ principals: ["code", "user"], effect: { kind: "workspace-service" }, tier: "open", sensitivity: "read" })
          async getNote(id: string): Promise<{ id: string }> { return { id }; }

          private helper(): void {}
        }
      `
    );
    writeFileSync(
      join(root, "provider.test.ts"),
      `class Fake { @rpc({ principals: ["code"], tier: "open", sensitivity: "read" }) nope() {} }`
    );

    expect(collectWorkspaceRpcCatalog(root)).toEqual([
      {
        className: "NotesDO",
        name: "getNote",
        signature: "getNote(id: string): Promise<{ id: string }>",
        description: "Return one note without changing it.",
        effect: { kind: "workspace-service" },
        access: {
          principals: ["code", "user"],
          tier: "open",
          sensitivity: "read",
        },
      },
    ]);
  });
});
