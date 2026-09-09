import { describe, expect, it } from "vitest";
import {
  formatDesktopDiagnostics,
  isUnexpectedDesktopDiagnostic,
  unexpectedDesktopDiagnostics,
  type DesktopSmokeDiagnostic,
} from "../scripts/lib/desktop-smoke-diagnostics.mjs";

function diagnostic(overrides: Partial<DesktopSmokeDiagnostic> = {}): DesktopSmokeDiagnostic {
  return {
    type: "console",
    level: "warning",
    message: "renderer warning",
    url: "http://127.0.0.1:41771/shell.js",
    sourceId: "shell.js",
    timestamp: 1,
    ...overrides,
  };
}

describe("desktop pairing smoke diagnostics", () => {
  it("fails the smoke on shell event subscription warnings", () => {
    const failure = diagnostic({
      message: "[useShellEvent] watch open-settings failed: RemoteRpcError: Unknown event",
    });

    expect(isUnexpectedDesktopDiagnostic(failure)).toBe(true);
    expect(unexpectedDesktopDiagnostics([failure])).toEqual([failure]);
  });

  it("fails on renderer errors and lifecycle failures", () => {
    expect(isUnexpectedDesktopDiagnostic(diagnostic({ level: "error" }))).toBe(true);
    expect(
      isUnexpectedDesktopDiagnostic(
        diagnostic({
          type: "render-process-gone",
          level: "",
          message: "crashed",
        })
      )
    ).toBe(true);
    expect(
      isUnexpectedDesktopDiagnostic(
        diagnostic({
          type: "did-fail-load",
          level: "",
          message: "ERR_CONNECTION_REFUSED (-102)",
        })
      )
    ).toBe(true);
  });

  it("ignores non-actionable console levels and only the exact Electron CSP warning", () => {
    expect(isUnexpectedDesktopDiagnostic(diagnostic({ level: "info" }))).toBe(false);
    expect(
      isUnexpectedDesktopDiagnostic(
        diagnostic({
          message:
            "Electron Security Warning (Insecure Content-Security-Policy) This renderer process has no CSP",
        })
      )
    ).toBe(false);
    expect(
      isUnexpectedDesktopDiagnostic(
        diagnostic({ message: "Application Security Warning (Insecure Content-Security-Policy)" })
      )
    ).toBe(true);
  });

  it("only exempts Chromium's exact superseded-navigation failure", () => {
    expect(
      isUnexpectedDesktopDiagnostic(
        diagnostic({
          type: "did-fail-load",
          level: "",
          message: "ERR_ABORTED (-3); mainFrame=true",
        })
      )
    ).toBe(false);
    expect(
      isUnexpectedDesktopDiagnostic(
        diagnostic({
          type: "did-fail-load",
          level: "",
          message: "ERR_NETWORK_CHANGED (-21); mainFrame=true",
        })
      )
    ).toBe(true);
  });

  it("formats actionable diagnostics with their renderer location", () => {
    expect(formatDesktopDiagnostics([diagnostic()])).toBe(
      "console/warning in http://127.0.0.1:41771/shell.js: renderer warning"
    );
  });
});

describe("diagnostic origin", () => {
  // An uncaught rejection is reported against the document that hosts it, which
  // for a bundled app names the same index.html for every call site in the
  // application. Without the source the reader cannot tell which one failed.
  it("names the source file and line when it differs from the document", () => {
    expect(
      formatDesktopDiagnostics([
        {
          type: "console",
          level: "error",
          url: "http://127.0.0.1/_a/hash/index.html",
          sourceId: "http://127.0.0.1/_a/hash/assets/shell-4f2b.js",
          lineNumber: 9182,
          message: "Uncaught (in promise) RemoteRpcError",
        },
      ] as never)
    ).toBe(
      "console/error in http://127.0.0.1/_a/hash/index.html " +
        "(http://127.0.0.1/_a/hash/assets/shell-4f2b.js:9182): Uncaught (in promise) RemoteRpcError"
    );
  });

  it("stays quiet when the source adds nothing to the document", () => {
    expect(
      formatDesktopDiagnostics([
        {
          type: "console",
          level: "error",
          url: "http://127.0.0.1/panel.html",
          sourceId: "http://127.0.0.1/panel.html",
          message: "boom",
        },
      ] as never)
    ).toBe("console/error in http://127.0.0.1/panel.html: boom");
  });
});
