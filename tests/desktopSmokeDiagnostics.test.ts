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
