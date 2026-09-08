import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import { requireDevelopmentBaseCheckout } from "../../dev/developmentBaseConfig";
import { collectWorkspaceRpcCatalog } from "./workspaceRpcCatalog";

it("accepts every fenced RPC receiver declaration in the workspace skills through the real build parser", () => {
  const skills = join(requireDevelopmentBaseCheckout(process.cwd()), "skills");
  const root = mkdtempSync(join(tmpdir(), "workspace-skill-rpc-"));
  let declarations = 0;
  try {
    for (const entry of readdirSync(skills, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = join(entry.parentPath, entry.name);
      const markdown = readFileSync(file, "utf8");
      for (const block of markdown.matchAll(/```(?:ts|typescript|tsx)\n([\s\S]*?)```/g)) {
        const source = block[1]!;
        const receiverStarts = [...source.matchAll(/@rpc\s*\(/g)];
        const receivers = [...source.matchAll(/@rpc\(\{[\s\S]*?\}\)/g)];
        expect(receivers.length, `${relative(skills, file)} RPC example extraction`).toBe(
          receiverStarts.length
        );
        for (const match of receivers) {
          declarations++;
          // Extract just the receiver declaration: examples may deliberately use
          // omitted bodies or place a method outside its enclosing class.
          const filename = `${declarations}-${relative(skills, file).split(sep).join("-")}.ts`;
          writeFileSync(
            join(root, filename),
            `class Example${declarations} { ${match[0]} example(): void {} }`
          );
        }
      }
    }
    expect(declarations).toBeGreaterThan(0);
    const catalog = collectWorkspaceRpcCatalog(root, {
      provider: "workers/example",
      authority: {
        requests: [],
        provides: [
          {
            name: "calendar.write",
            title: "Update calendar",
            action: "update this calendar",
            tier: "gated",
            sensitivity: "write",
            resourceType: "calendar",
            presentation: { domain: "files", verb: "manage" },
            notability: "headline",
            grantScopes: ["once"],
          },
        ],
      },
    });
    expect(catalog).toHaveLength(declarations);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
