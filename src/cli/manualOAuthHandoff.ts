import * as readline from "node:readline";

/**
 * Manual OAuth handoff: the operator's browser is not on this host (or no
 * launcher exists here), so the CLI prints the authorization URL and accepts
 * the resulting callback URL back on stdin. Guidance goes to stderr so
 * `--json` stdout stays a single machine-readable result.
 */
export interface ManualHandoffIo {
  write(line: string): void;
  input: NodeJS.ReadableStream & { isTTY?: boolean };
}

const DEFAULT_IO: ManualHandoffIo = {
  write: (line) => process.stderr.write(line),
  input: process.stdin,
};

/** Print the URL the operator must open, plus how the connection completes. */
export function presentAuthorizeUrl(
  context: { authorizeUrl: string; redirectUri: string },
  io: ManualHandoffIo = DEFAULT_IO
): void {
  io.write(
    [
      "",
      "Open this URL in a browser to authorize the provider:",
      "",
      `  ${context.authorizeUrl}`,
      "",
      `If that browser runs on this machine, the connection completes by itself through ${context.redirectUri}.`,
      "Otherwise finish the sign-in, copy the full URL from the browser's address bar",
      `(it starts with ${redirectOrigin(context.redirectUri)}) and paste it here, then press Enter:`,
      "",
    ].join("\n") + "\n"
  );
}

/**
 * Read one pasted callback URL. The promise stays pending — never rejects —
 * when stdin ends or carries nothing usable, so the loopback listener remains
 * the deciding route instead of being cancelled by an empty paste.
 */
export function readPastedCallbackUrl(io: ManualHandoffIo = DEFAULT_IO): Promise<string> {
  return new Promise<string>((resolve) => {
    const lines = readline.createInterface({ input: io.input });
    lines.on("line", (line) => {
      const value = line.trim();
      if (!value) return;
      if (!/^https?:\/\//u.test(value)) {
        io.write("That is not a callback URL; paste the full http(s) URL from the browser.\n");
        return;
      }
      lines.close();
      resolve(value);
    });
    lines.on("close", () => undefined);
  });
}

function redirectOrigin(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return redirectUri;
  }
}
