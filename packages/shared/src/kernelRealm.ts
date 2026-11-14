/**
 * The realm of an eval kernel's isolate (docs/dolt-redesign.md §7.6).
 *
 * A kernel is hosted code that compiles guest code with `new Function`, and
 * every kernel of every entity that uses the same executable shares one isolate.
 * Guest code must therefore not reach the compiler through a prototype chain,
 * and must not be able to change an intrinsic another owner's cells will see.
 * Importing this module for its effect, before anything else in the kernel's
 * entry, keeps the realm's real compiler for the kernel (`getRealmCompiler`),
 * then locks the realm down with SES. The node grants `codegen` to that
 * isolate alone (the manifest's `hosted.codegen`); nothing else may compile.
 */
import "ses";
import { captureRealmCompiler } from "./evalConfinement.js";

type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";

// SES freezes the realm console. Install one stable facade first: its methods
// forward to the native console, so the frozen object keeps working.
(() => {
  const nativeConsole = console;
  const consoleFacade = Object.create(null) as Console;
  const names = new Set([
    ...Object.getOwnPropertyNames(nativeConsole),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(nativeConsole)),
  ]);
  for (const name of names) {
    if (name === "constructor") continue;
    const value = (nativeConsole as unknown as Record<string, unknown>)[name];
    if (typeof value === "function") {
      (consoleFacade as unknown as Record<string, unknown>)[name] = value.bind(nativeConsole);
    } else if (value !== undefined) {
      (consoleFacade as unknown as Record<string, unknown>)[name] = value;
    }
  }
  for (const level of ["debug", "log", "info", "warn", "error"] as ConsoleLevel[]) {
    consoleFacade[level] = (...args: unknown[]) => nativeConsole[level](...args);
  }
  globalThis.console = consoleFacade;

  captureRealmCompiler();
  lockdown({
    errorTaming: "unsafe",
    overrideTaming: "severe",
    evalTaming: "no-eval",
  });
})();

export {};
