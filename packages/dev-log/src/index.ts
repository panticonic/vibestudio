/**
 * Simple development logging utility with log levels.
 *
 * Controls verbosity of console output during development.
 * Set VIBESTUDIO_LOG_LEVEL environment variable to control output:
 *   - "trace" - Per-event lifecycle traces and all other logs
 *   - "verbose" - Detailed diagnostics and all operational logs
 *   - "info" - Normal operational logs (default)
 *   - "warn" - Warnings and errors only
 *   - "error" - Errors only
 *   - "silent" - No logs
 */

export type LogLevel = "trace" | "verbose" | "info" | "warn" | "error" | "silent";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  verbose: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5,
};

function getLogLevel(): LogLevel {
  const level = process.env["VIBESTUDIO_LOG_LEVEL"] as LogLevel | undefined;
  if (level && level in LOG_LEVEL_PRIORITY) {
    return level;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getLogLevel()];
}

/** Log a per-event trace. Use for high-frequency lifecycle churn. */
export function logTrace(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("trace")) {
    console.debug(`[${tag}] ${message}`, ...args);
  }
}

/** Log at verbose level - detailed diagnostic information. */
export function logVerbose(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("verbose")) {
    // Keep diagnostic output on console.debug so the server log capture can
    // preserve its verbose level instead of misclassifying it as info.
    console.debug(`[${tag}] ${message}`, ...args);
  }
}

/**
 * Log at info level - normal operational messages.
 * Use for: server startup, significant state changes.
 */
export function logInfo(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("info")) {
    console.log(`[${tag}] ${message}`, ...args);
  }
}

/**
 * Log at warn level - potential issues.
 * Use for: missing optional config, degraded functionality.
 */
export function logWarn(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("warn")) {
    console.warn(`[${tag}] ${message}`, ...args);
  }
}

/**
 * Log at error level - actual errors.
 */
export function logError(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("error")) {
    console.error(`[${tag}] ${message}`, ...args);
  }
}

/**
 * Check if verbose logging is enabled.
 * Useful for conditionally computing expensive log data.
 */
export function isVerbose(): boolean {
  return shouldLog("verbose");
}

/** Check if per-event trace logging is enabled. */
export function isTrace(): boolean {
  return shouldLog("trace");
}

/**
 * Create a scoped logger for a specific component.
 */
export function createDevLogger(tag: string) {
  return {
    trace: (message: string, ...args: unknown[]) => logTrace(tag, message, ...args),
    verbose: (message: string, ...args: unknown[]) => logVerbose(tag, message, ...args),
    info: (message: string, ...args: unknown[]) => logInfo(tag, message, ...args),
    warn: (message: string, ...args: unknown[]) => logWarn(tag, message, ...args),
    error: (message: string, ...args: unknown[]) => logError(tag, message, ...args),
    isTrace: () => isTrace(),
    isVerbose: () => isVerbose(),
  };
}
