/**
 * Workerd-only entry for product-owned Durable Objects.
 *
 * Lock down the isolate before any DO class is instantiated. Eval guests share
 * an isolate with product code and other owners, so mutable intrinsics would be
 * a cross-tenant channel even after free-name confinement. This entry is kept
 * separate from index.ts because Node source tests import the classes directly;
 * freezing the Vitest process would test a different boundary than production.
 */
import "ses";

type ConsoleLevel = "log" | "info" | "warn" | "error";
type ConsoleSink = (level: ConsoleLevel, args: unknown[]) => void;

// SES freezes the realm console. Install one stable facade first; runtime code
// changes only its closure-held sink and never mutates the hardened console
// object. The installer is host bootstrap plumbing and is absent from eval's
// private guest global.
const nativeConsole = console;
let consoleSink: ConsoleSink | undefined;
const consoleFacade = Object.create(null) as Console;
const consoleNames = new Set([
  ...Object.getOwnPropertyNames(nativeConsole),
  ...Object.getOwnPropertyNames(Object.getPrototypeOf(nativeConsole)),
]);
for (const name of consoleNames) {
  if (name === "constructor") continue;
  const value = (nativeConsole as unknown as Record<string, unknown>)[name];
  if (typeof value === "function") {
    (consoleFacade as unknown as Record<string, unknown>)[name] = value.bind(nativeConsole);
  } else if (value !== undefined) {
    (consoleFacade as unknown as Record<string, unknown>)[name] = value;
  }
}
for (const level of ["log", "info", "warn", "error"] as const) {
  consoleFacade[level] = (...args: unknown[]) =>
    consoleSink ? consoleSink(level, args) : nativeConsole[level](...args);
}
// SES repairs the console binding during lockdown. Keep the bootstrap binding
// ordinary until that repair is complete; the facade itself is then frozen,
// while its methods retain access to the closure-held sink.
globalThis.console = consoleFacade;

lockdown({
  errorTaming: "unsafe",
  overrideTaming: "severe",
});

Object.defineProperty(globalThis, "__vibestudioInstallConsoleSink", {
  value: (sink: ConsoleSink) => {
    consoleSink = sink;
  },
  writable: false,
  configurable: false,
});

export * from "./index.js";
