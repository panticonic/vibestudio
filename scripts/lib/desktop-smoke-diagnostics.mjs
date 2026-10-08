const ACTIONABLE_CONSOLE_LEVELS = new Set(["warning", "error"]);

/**
 * Electron emits this development-only warning itself when a renderer does not
 * install a production CSP. It does not describe an application failure and
 * disappears from packaged builds. Keep the exception exact and named: other
 * renderer warnings remain smoke failures.
 */
const BENIGN_RENDERER_CONSOLE_MESSAGES = [
  /^Electron Security Warning \(Insecure Content-Security-Policy\)/,
];

export function isUnexpectedDesktopDiagnostic(diagnostic) {
  if (
    diagnostic.type === "did-fail-load" &&
    /^ERR_ABORTED \(-3\); mainFrame=(?:true|false)$/.test(diagnostic.message)
  ) {
    // Chromium reports a superseded navigation as a failed load. The host's
    // navigation owner treats this exact code as routine cancellation; no
    // broader network or lifecycle failure is exempted here.
    return false;
  }
  if (diagnostic.type !== "console") return true;
  if (!ACTIONABLE_CONSOLE_LEVELS.has(diagnostic.level)) return false;
  // Attribute console output to its emitting document. A cross-origin embed
  // owns its console; a CDN script executing in our document still belongs to us.
  // Missing or opaque frame identity remains actionable.
  if (
    diagnostic.isMainFrame === false &&
    URL.canParse(diagnostic.frameUrl) &&
    URL.canParse(diagnostic.url)
  ) {
    const frameOrigin = new URL(diagnostic.frameUrl).origin;
    const documentOrigin = new URL(diagnostic.url).origin;
    if (frameOrigin !== "null" && documentOrigin !== "null" && frameOrigin !== documentOrigin)
      return false;
  }
  return !BENIGN_RENDERER_CONSOLE_MESSAGES.some((pattern) => pattern.test(diagnostic.message));
}

export function unexpectedDesktopDiagnostics(diagnostics) {
  return diagnostics.filter(isUnexpectedDesktopDiagnostic);
}

export function formatDesktopDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const location =
        diagnostic.frameUrl || diagnostic.url || diagnostic.sourceId || "unknown renderer";
      const level = diagnostic.type === "console" ? `/${diagnostic.level}` : "";
      // The document URL names the renderer; the source names the code. For an
      // uncaught rejection they differ, and only the second is actionable, so a
      // reader is not left to guess which of a bundle's call sites is at fault.
      const sourceId = diagnostic.sourceId ?? "";
      const namesTheSameFile = !sourceId || location === sourceId || location.endsWith(sourceId);
      const origin = namesTheSameFile
        ? ""
        : ` (${sourceId}${diagnostic.lineNumber ? `:${diagnostic.lineNumber}` : ""})`;
      return `${diagnostic.type}${level} in ${location}${origin}: ${diagnostic.message}`;
    })
    .join("\n");
}
