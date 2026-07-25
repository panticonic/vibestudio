import { app } from "electron";

export interface RelaunchOptions {
  args?: string[];
  exitCode?: number;
}

let installedHandler: ((opts: RelaunchOptions) => void) | null = null;

/** Main installs the lifecycle-owned handler once its quit state exists. */
export function installRelaunchHandler(handler: (opts: RelaunchOptions) => void): void {
  if (installedHandler) throw new Error("The app relaunch handler is already installed");
  installedHandler = handler;
}

/**
 * Request a relaunch through main's lifecycle-owned quit state. The fallback is
 * retained for isolated service tests that do not load the main entry point.
 * `exitCode` defaults to 0; crash recovery passes 1. `args` overrides the
 * relaunched process argv.
 */
export function relaunchApp(opts: RelaunchOptions = {}): void {
  if (installedHandler) {
    installedHandler(opts);
    return;
  }
  if (opts.args) app.relaunch({ args: opts.args });
  else app.relaunch();
  app.exit(opts.exitCode ?? 0);
}
