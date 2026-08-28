import { createRequire } from "node:module";
import path from "node:path";

export type IrohNodeBinding = typeof import("@number0/iroh");

// Product hosts are bundled as CJS, while transport tests execute this source
// as ESM. Prefer the bundle's own resolver so native dependencies resolve next
// to the installed host; the ESM path anchors resolution at the invoking
// checkout, where the workspace dependency graph is installed.
const runtimeRequire: NodeJS.Require =
  typeof require === "function"
    ? require
    : createRequire(path.join(process.cwd(), "__vibestudio_iroh_resolver.cjs"));
let cachedBinding: IrohNodeBinding | null = null;

export function loadIrohNodeBinding(): IrohNodeBinding {
  if (cachedBinding) return cachedBinding;
  // The exact upstream 1.1.0 tarball declares a stale `iroh-js/index.js` main
  // while publishing the generated binding at its package root. Resolve the
  // immutable package coordinate and load that published entry directly; do
  // not rewrite the third-party manifest in node_modules or in packaged apps.
  const binding = runtimeRequire(resolveIrohNodeBinding()) as Partial<IrohNodeBinding>;
  if (
    typeof binding.Endpoint !== "function" ||
    typeof binding.SecretKey !== "function" ||
    typeof binding.RelayMode !== "function"
  ) {
    throw new Error("@number0/iroh loaded without its required native endpoint exports");
  }
  cachedBinding = binding as IrohNodeBinding;
  return cachedBinding;
}

export function resolveIrohNodeBinding(): string {
  return path.join(path.dirname(runtimeRequire.resolve("@number0/iroh/package.json")), "index.js");
}
