export interface DesktopSmokeDiagnostic {
  type: "console" | "did-fail-load" | "render-process-gone" | "unresponsive";
  level: string;
  message: string;
  url: string;
  sourceId: string;
  timestamp: number;
}

export function isUnexpectedDesktopDiagnostic(diagnostic: DesktopSmokeDiagnostic): boolean;
export function unexpectedDesktopDiagnostics(
  diagnostics: readonly DesktopSmokeDiagnostic[]
): DesktopSmokeDiagnostic[];
export function formatDesktopDiagnostics(diagnostics: readonly DesktopSmokeDiagnostic[]): string;
