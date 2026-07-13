export const RELEASE_ANDROID_PACKAGE = "app.vibestudio.mobile";
export const INTERNAL_ANDROID_PACKAGE = "app.vibestudio.mobile.internal";

export function parseAdbDevices(output) {
  return String(output)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(/\s+/);
      const deviceId = fields.shift();
      const state = fields.shift();
      if (!deviceId || !state) return null;
      const attributes = Object.fromEntries(
        fields.flatMap((field) => {
          const separator = field.indexOf(":");
          return separator > 0 ? [[field.slice(0, separator), field.slice(separator + 1)]] : [];
        })
      );
      return { deviceId, state, attributes };
    })
    .filter(Boolean);
}

export function parseAndroidPackageVersion(output) {
  const match = String(output).match(/^\s*versionName=([^\s]+)\s*$/m);
  return match?.[1];
}

export function versionsCompatible(installed, expected) {
  if (!installed || !expected) return false;
  const normalize = (value) => String(value).trim().replace(/^v/, "").split(/[+-]/)[0];
  return normalize(installed) === normalize(expected);
}
