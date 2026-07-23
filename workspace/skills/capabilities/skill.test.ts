import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";

describe("capabilities skill", () => {
  it("teaches context-relative service enumeration without a static census", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
    expect(markdown).toContain('docs_search({ query: "", surface: "workspace" })');
    expect(markdown).toContain('`workspace_service` with `operation: "upsert"`');
    expect(markdown).toContain("do not search source files or another unit's manifest");
    expect(markdown).toContain("keep docs outside eval");
    expect(markdown).toContain("`docs`, `docs.search`, and `docs.open` are undefined");
    expect(markdown).toContain("`singletonObjects` row as one schema-validated semantic edit");
    expect(markdown).toContain("If the\n   row is absent, stop");
    expect(markdown).toContain(
      "`workspace-service` describes a declared service boundary, not every method"
    );
    expect(markdown).toContain("`workers.resolveDurableObject(...)` instead declares");
    expect(markdown).toContain('`effect: { kind: "runtime-intrinsic" }`');
    expect(markdown).toContain("fail closed when mixed");
  });

  it("keeps the installed-consumer manifest recipe accepted by the runtime parser", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
    const section = markdown.split("Consumer manifest fragment", 2)[1];
    const fencedJson = section?.match(/```json\s*([\s\S]*?)```/u)?.[1];
    expect(fencedJson).toBeTruthy();

    const packageJson = JSON.parse(fencedJson!) as {
      vibestudio?: { authority?: unknown };
    };
    expect(() =>
      parseUnitAuthorityManifest(
        packageJson.vibestudio?.authority,
        "capabilities skill installed-consumer recipe"
      )
    ).not.toThrow();
    expect(section).toContain('import { contextId, rpc, workers } from "@workspace/runtime"');
    expect(section).toContain("services.build.getBuildReport(source, `ctx:${contextId}`)");
    expect(section).toContain('report.status !== "ok"');
    expect(section).toContain("workers.create(source");
    expect(section).toContain('rpc.call(handle.targetId, "consumeLocalService", [])');
    expect(section).toContain("workers.destroy(handle)");
    expect(section).toContain("return the provider result intact");
    expect(section).toContain("runtime.rpc.call<ThatResult>");
    expect(markdown).toContain("never write `import { workers, type }");
  });

  it("teaches one exact-version review and progressive capability disclosure", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
    expect(markdown).toContain("one startup batch");
    expect(markdown).toContain("apps, native\n  extensions, panels, workers");
    expect(markdown).toContain("it does not approve\n  itself");
    expect(markdown).toContain("activation must not ask the same question again");
    expect(markdown).toContain("Added capabilities are shown first");
    expect(markdown).toContain(
      "Direct unit capabilities and evaluated-code ceilings are sections of this same"
    );
    expect(markdown).toContain("does not turn an eval ceiling into a grant");
    expect(markdown).toContain("no session-duration source-change bypass exists");
  });

  it("distinguishes agent delegation from installed-code version review", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
    expect(markdown).toContain("An agent-owned eval is a conduit");
    expect(markdown).toContain("Trust this agent");
    expect(markdown).toContain("not an installed-code update or version decision at all");
    expect(markdown).toMatch(/Every eval still receives its\s+own code review/u);
  });

  it("teaches exact mission closure and immutable product seeding", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
    expect(markdown).toContain("immutable, content-addressed authority closure");
    expect(markdown).toContain("standing restrictions as durable deny grants");
    expect(markdown).toContain('workspaceServiceDiscovery: "live-declarations"');
    expect(markdown).toContain("it grants no service capability");
    expect(markdown).toContain("event triggers inside the closed filter grammar");
    expect(markdown).toContain("reconciled from immutable product snapshot outputs");
    expect(markdown).toContain("makes an old closure inert before replacing its");
  });

  it("keeps the System Agent boundary explicit", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
    expect(markdown).toContain("exactly `eval` and `say`");
    expect(markdown).toMatch(
      /host-derived per `\(workspace, authenticated user, product\s+snapshot\)`/u
    );
    expect(markdown).toContain("exact locked roster");
    expect(markdown).toContain("cannot settle approvals");
    expect(markdown).toContain("Do not add a System-Agent-only transport");
  });

  it("links the host authority implementation checklist", () => {
    const markdown = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
    const checklist = readFileSync(
      new URL("./references/authority-implementation-checklist.md", import.meta.url),
      "utf8"
    );
    expect(markdown).toContain("references/authority-implementation-checklist.md");
    expect(checklist).toContain("hostCapabilityPresentations.ts");
    expect(checklist).toContain("runtime-authority-review.json");
    expect(checklist).toContain("Regenerating derived ledgers is not");
    expect(checklist).toContain("desktop and mobile clients call the same typed lifecycle service");
  });
});
