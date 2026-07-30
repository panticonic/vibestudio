export function decodePanelStateArgs(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored panel stateArgs must be a JSON object");
  }
  return value as Record<string, unknown>;
}
