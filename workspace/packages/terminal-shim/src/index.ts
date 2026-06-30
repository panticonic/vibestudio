/**
 * @workspace/terminal-shim — the workerd runtime environment for Ink terminal
 * apps. Provides duck-typed TTY streams, a resizable terminal-size source, and
 * the yoga loader (`@workspace/terminal-shim/yoga`, aliased over `yoga-layout`
 * by the terminal-worker build). Keep this minimal: `nodejs_compat` already
 * supplies process/stream/events/Buffer/setImmediate.
 */
export {
  createInkTerminalSession,
  type CreateInkTerminalSessionOptions,
  type InkTerminalSession,
  type TerminalHostSink,
  type TerminalSize,
} from "./runtime/createInkTerminalSession.js";
export { Vibez1WritableTTY } from "./streams/Vibez1WritableTTY.js";
export { Vibez1ReadableTTY } from "./streams/Vibez1ReadableTTY.js";
