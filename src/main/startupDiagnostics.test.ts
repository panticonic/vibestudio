import { describe, expect, it } from "vitest";
import {
  createStartupErrorReport,
  resolveStartupErrorPaths,
  startupPathDiagnosticEntries,
} from "./startupDiagnostics.js";

describe("startup diagnostics policy", () => {
  it("stores bootstrap failures under userData before a workspace is known", () => {
    expect(resolveStartupErrorPaths("/config/vibestudio")).toEqual({
      directory: "/config/vibestudio",
      reportPath: "/config/vibestudio/startup-error.json",
    });
  });

  it("stores workspace failures and their server-log pointer under workspace state", () => {
    expect(resolveStartupErrorPaths("/config/vibestudio", "/workspaces/demo")).toEqual({
      directory: "/workspaces/demo/state",
      reportPath: "/workspaces/demo/state/startup-error.json",
      serverLogPath: "/workspaces/demo/state/logs/server.log",
    });
  });

  it("builds a serializable error report with stable time and stack detail", () => {
    const error = new Error("server failed");
    error.stack = "Error: server failed\n    at startup";
    const paths = resolveStartupErrorPaths("/config", "/workspaces/demo");

    expect(createStartupErrorReport(error, paths, new Date("2026-07-13T12:00:00.000Z"))).toEqual({
      failedAt: "2026-07-13T12:00:00.000Z",
      message: "server failed",
      detail: "Error: server failed\n    at startup",
      logPath: "/workspaces/demo/state/logs/server.log",
    });
  });

  it("orders early path diagnostics for readable output", () => {
    const entries = startupPathDiagnosticEntries({
      platform: "linux",
      arch: "x64",
      cwd: "/cwd",
      execPath: "/electron",
      appPath: "/app",
      userDataPath: "/config",
      nodeEnv: "development",
      isDevelopment: true,
      appRoot: "/repo",
    });

    expect(entries).toEqual([
      ["[diagnostics] process.platform:", "linux"],
      ["[diagnostics] process.arch:", "x64"],
      ["[diagnostics] process.cwd():", "/cwd"],
      ["[diagnostics] process.execPath:", "/electron"],
      ["[diagnostics] app.getAppPath():", "/app"],
      ["[diagnostics] app.getPath('userData'):", "/config"],
      ["[diagnostics] NODE_ENV:", "development"],
      ["[diagnostics] isDev():", true],
      ["[diagnostics] getAppRoot():", "/repo"],
    ]);
  });
});
