import { redactToken } from "@vibestudio/shared/redact";

/**
 * CLI output + exit-code conventions.
 *
 * Exit codes:
 *   0 — success
 *   1 — operation error (RPC error, missing session, etc.)
 *   2 — usage error (unknown command/flag, malformed args)
 *   3 — auth/connection error (not paired, refresh rejected, server unreachable)
 *   4 — timeout
 *   5 — stale session (local session file points at a retired/unknown entity)
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_TIMEOUT = 4;
export const EXIT_STALE_SESSION = 5;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = EXIT_ERROR
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_USAGE);
    this.name = "UsageError";
  }
}

export class AuthError extends CliError {
  constructor(message: string) {
    super(message, EXIT_AUTH);
    this.name = "AuthError";
  }
}

export class TimeoutError extends CliError {
  constructor(message: string) {
    super(message, EXIT_TIMEOUT);
    this.name = "TimeoutError";
  }
}

export class StaleSessionError extends CliError {
  constructor(message: string) {
    super(message, EXIT_STALE_SESSION);
    this.name = "StaleSessionError";
  }
}

/**
 * Whether results should be emitted as JSON: explicit --json flag, or
 * automatically when stdout is not a TTY (piped/captured output).
 */
export function jsonMode(jsonFlag: boolean | undefined): boolean {
  if (jsonFlag === true) return true;
  return !process.stdout.isTTY;
}

/**
 * Print a command result. In JSON mode the value is emitted as a single
 * JSON document; otherwise the optional `human` renderer is used (falling
 * back to pretty-printed JSON for structured values, raw text for strings).
 */
export function printResult(value: unknown, options: { json: boolean; human?: () => void }): void {
  if (options.json) {
    console.log(JSON.stringify(value === undefined ? null : value));
    return;
  }
  if (options.human) {
    options.human();
    return;
  }
  if (value === undefined) return;
  if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

const REFRESH_TOKEN_COMPOSITE = /\brefresh:([^:\s]+):([^\s"'`<>]+)/g;
const BEARER_TOKEN = /\bBearer\s+([A-Za-z0-9._~+/=-]{9,})\b/g;

export function redactCliSecrets(message: string): string {
  return message
    .replace(REFRESH_TOKEN_COMPOSITE, (token) => redactToken(token))
    .replace(BEARER_TOKEN, (_match, token: string) => `Bearer ${redactToken(token)}`);
}

/** Print an error and return the exit code it maps to. */
export function printError(error: unknown, options: { json: boolean }): number {
  const message = redactCliSecrets(error instanceof Error ? error.message : String(error));
  const exitCode = error instanceof CliError ? error.exitCode : EXIT_ERROR;
  if (options.json) {
    console.error(JSON.stringify({ error: message, exitCode }));
  } else {
    console.error(message);
  }
  return exitCode;
}
