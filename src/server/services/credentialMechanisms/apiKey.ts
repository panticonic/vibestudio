import { OAuthConnectionError } from "./errors.js";

const API_KEY_PLACEHOLDER = /\{[a-zA-Z0-9._@+=:-]+\}/g;
const API_KEY_PLACEHOLDER_CAPTURE = /\{([a-zA-Z0-9._@+=:-]+)\}/g;

export function validateApiKeyMaterialTemplate(
  template: string,
  fieldNames: readonly string[]
): void {
  const declared = new Set(fieldNames);
  const placeholders = template.match(API_KEY_PLACEHOLDER) ?? [];
  if (placeholders.length === 0) {
    throw new OAuthConnectionError(
      "invalid_connection_spec",
      "api-key materialTemplate must reference at least one field"
    );
  }
  for (const placeholder of placeholders) {
    const name = placeholder.slice(1, -1);
    if (!declared.has(name)) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        `api-key materialTemplate references undeclared field: ${name}`
      );
    }
  }
}

export function renderApiKeyMaterialTemplate(
  template: string,
  values: Readonly<Record<string, string>>
): string {
  return template.replace(API_KEY_PLACEHOLDER_CAPTURE, (_match, name: string) => {
    return values[name]?.trim() ?? "";
  });
}
