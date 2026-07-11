/** Exact opaque identifier and secret grammars emitted by the pre-release
 * device credential issuer. Persisted clients accept only these current forms. */
export const SERVER_ID_PATTERN = /^srv_[A-Za-z0-9_-]{24}$/;
export const SERVER_BOOT_ID_PATTERN = /^boot_[A-Za-z0-9_-]{24}$/;
export const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{24}$/;
export const DEVICE_REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isServerId(value: unknown): value is string {
  return typeof value === "string" && SERVER_ID_PATTERN.test(value);
}

export function isServerBootId(value: unknown): value is string {
  return typeof value === "string" && SERVER_BOOT_ID_PATTERN.test(value);
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

export function isDeviceRefreshToken(value: unknown): value is string {
  return typeof value === "string" && DEVICE_REFRESH_TOKEN_PATTERN.test(value);
}
