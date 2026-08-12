import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { developerErgonomicsTests } from "./developer-ergonomics.js";

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
  details: Record<string, unknown>,
  failed = false
) {
  return {
    kind: "message" as const,
    senderId: "agent",
    senderMetadata: { type: "agent" },
    complete: true,
    contentType: "invocation" as const,
    invocation: {
      id,
      name,
      arguments: args,
      execution: {
        status: failed ? ("error" as const) : ("complete" as const),
        isError: failed,
        ...(failed ? { failureKind: "user-code", failureCode: "guest_execution_failed" } : {}),
        result: { protocolContent: [], details },
      },
    },
  };
}

function execution(calls: ReturnType<typeof call>[]): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      ...calls,
      {
        kind: "message",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        complete: true,
        content: "The requested recovery and final verification completed successfully.",
      },
    ],
  } as TestExecutionResult;
}

function failure(code: string, data: Record<string, unknown>) {
  return {
    failure: {
      protocol: "agent-tool-failure.v1",
      code,
      kind: "conflict",
      message: code,
      operation: "tool.execute",
      stage: "execute",
      retry: { policy: "reobserve", commandIdPolicy: "use-new-after-reobserve" },
      recovery: data["recovery"],
      causes: [{ role: "primary", code, message: code }],
      data,
    },
  };
}

function receipt(target: string, status: "ok" | "failed") {
  return {
    protocol: "build-verification-receipt.v1",
    target,
    contextId: "context:test",
    ref: "ctx:context:test",
    reportDigest: "a".repeat(64),
    unit: { repoPath: target, kind: "package" },
    status,
    builds: [{ target: "library:panel", buildKey: "b".repeat(64) }],
    diagnostics: {
      total: status === "failed" ? 60 : 0,
      retained: status === "failed" ? 40 : 0,
      truncated: status === "failed" ? 20 : 0,
    },
  };
}

function scenario(name: string) {
  return developerErgonomicsTests.find((test) => test.name === name)!;
}

describe("developer ergonomics scenarios", () => {
  it("registers the focused regression names and induced failure policy", () => {
    expect(developerErgonomicsTests.map((test) => test.name)).toEqual([
      "invalid-icon-discover-recover-create",
      "failed-build-bounded-diagnostics",
      "extensionless-screenshot-resource-read",
      "panel-rebuild-reacquire-and-interact",
      "stale-edit-reobserve-and-apply",
    ]);
    expect(scenario("failed-build-bounded-diagnostics").expectedToolFailures).toEqual([
      { name: "verify", errorIncludes: "Build failed" },
    ]);
    expect(scenario("invalid-icon-discover-recover-create").expectedToolFailures).toEqual([
      { name: "eval", errorIncludes: "project_icon_invalid" },
    ]);
    expect(scenario("stale-edit-reobserve-and-apply").expectedToolFailures).toEqual([
      { name: "apply_patch", errorIncludes: "WorkspaceReadConflict" },
    ]);
  });

  it("accepts typed invalid-icon correction followed by bounded discovery and creation", () => {
    const catalog = {
      protocol: "workspace-dev-catalog.v1",
      resource: "icon",
      query: "columns-3",
      total: 39,
      entries: [{ id: "lucide:columns", family: "lucide", name: "columns" }],
      truncated: 38,
    };
    const rejected = call(
      "invalid-icon",
      "eval",
      { code: "return createProjects(requested);" },
      failure("project_icon_invalid", {
        recovery: { action: "correct-request", instruction: "Choose from the catalog" },
        catalog,
      }),
      true
    );
    const discovered = call(
      "catalog",
      "eval",
      { code: "return searchProjectCatalog(query);" },
      { returnValue: catalog }
    );
    const created = call(
      "created",
      "eval",
      { code: "return createProjects(corrected);" },
      {
        returnValue: {
          created: "panels/columns-board",
          preflight: { ok: true, projectType: "panel" },
          publication: { published: true },
        },
      }
    );

    expect(
      scenario("invalid-icon-discover-recover-create").validate(
        execution([rejected, discovered, created])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts proactive bounded discovery that avoids the invalid-icon failure", () => {
    const catalog = {
      protocol: "workspace-dev-catalog.v1",
      resource: "icon",
      query: "columns-3",
      total: 39,
      entries: [{ id: "lucide:columns", family: "lucide", name: "columns" }],
      truncated: 38,
    };
    const discovered = call(
      "catalog",
      "eval",
      { code: "return searchProjectCatalog(query);" },
      { returnValue: catalog }
    );
    const created = call(
      "created",
      "eval",
      { code: "return createProjects(corrected);" },
      {
        returnValue: {
          created: "panels/columns-board",
          preflight: { ok: true, projectType: "panel" },
          publication: { published: true },
        },
      }
    );

    expect(
      scenario("invalid-icon-discover-recover-create").validate(execution([discovered, created]))
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts a truncated failed build only when a later receipt is clean", () => {
    const target = "packages/fixture";
    const diagnostics = Array.from({ length: 40 }, (_, index) => ({
      source: "tsc",
      severity: "error",
      file: `${target}/index.ts`,
      line: index + 1,
      column: 1,
      message: `failure ${index + 1}`,
    }));
    const failed = call(
      "failed-build",
      "verify",
      { operation: "build", target },
      {
        operation: "build",
        target,
        status: "failed",
        report: { diagnostics },
        receipt: receipt(target, "failed"),
        truncatedDiagnostics: 20,
      },
      true
    );
    const clean = call(
      "clean-build",
      "verify",
      { operation: "build", target },
      {
        operation: "build",
        target,
        status: "ok",
        report: { diagnostics: [] },
        receipt: receipt(target, "ok"),
        truncatedDiagnostics: 0,
      }
    );

    expect(
      scenario("failed-build-bounded-diagnostics").validate(execution([failed, clean]))
    ).toEqual({ passed: true, reason: undefined });
  });

  it("requires native image evidence from the same extensionless scratch capture", () => {
    const capture = call(
      "capture",
      "eval",
      {
        code: "const bytes = await page.screenshot(); const path = await fs.mktemp('capture'); return path;",
      },
      { returnValue: "file:/.tmp/capture-123" }
    );
    const read = call(
      "read",
      "read",
      { target: "file:/.tmp/capture-123" },
      { mimeType: "image/png", size: 4096 }
    );

    expect(
      scenario("extensionless-screenshot-resource-read").validate(execution([capture, read]))
    ).toEqual({ passed: true, reason: undefined });
  });

  it("requires a replaced session and an observed postcondition after rebuild", () => {
    const open = call(
      "open",
      "eval",
      { code: "scope.session = await scope.panel.cdp.session();" },
      { returnValue: { protocol: "panel-cdp-session.v1" } }
    );
    const verify = call(
      "verify",
      "verify",
      { operation: "build", target: "panels/counter" },
      { status: "ok" }
    );
    const edit = call(
      "edit",
      "apply_patch",
      { operations: [] },
      { applicationId: "application:counter" }
    );
    const rebuild = call(
      "rebuild",
      "eval",
      {
        code: "await scope.panel.rebuild(); const refreshed = await scope.session.refresh();",
      },
      {
        returnValue: {
          status: "replaced",
          previousGeneration: { attemptId: "attempt:old" },
          interaction: {
            protocol: "cdp-interaction-outcome.v1",
            delivery: "dispatched",
            effect: { status: "observed", state: "visible" },
          },
        },
      }
    );

    expect(
      scenario("panel-rebuild-reacquire-and-interact").validate(
        execution([open, verify, edit, rebuild])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("requires a stale receipt refusal with fresh evidence before the corrected patch", () => {
    const readReceipt = {
      protocol: "workspace-read-receipt.v1",
      path: "projects/fixture/README.md",
      contentHash: "a".repeat(64),
      byteLength: 12,
    };
    const currentReceipt = { ...readReceipt, contentHash: "b".repeat(64), byteLength: 18 };
    const read = call("read", "read", { path: readReceipt.path }, { receipt: readReceipt });
    const first = call("first", "apply_patch", { operations: [] }, { applicationId: "one" });
    const stale = call(
      "stale",
      "apply_patch",
      { operations: [{ receipt: readReceipt }] },
      failure("WorkspaceReadConflict", {
        recovery: { action: "reobserve", instruction: "Use current receipt" },
        currentReceipt,
      }),
      true
    );
    const corrected = call(
      "corrected",
      "apply_patch",
      { operations: [{ receipt: currentReceipt }] },
      { applicationId: "two" }
    );

    expect(
      scenario("stale-edit-reobserve-and-apply").validate(
        execution([read, first, stale, corrected])
      )
    ).toEqual({ passed: true, reason: undefined });
  });
});
