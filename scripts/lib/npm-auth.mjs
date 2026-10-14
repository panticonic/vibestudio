import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function npmTokenFilePath(env = process.env) {
  const expandHome = (value) =>
    value === "~"
      ? os.homedir()
      : value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  if (env.VIBESTUDIO_NPM_TOKEN_FILE) return path.resolve(expandHome(env.VIBESTUDIO_NPM_TOKEN_FILE));
  const configHome = env.XDG_CONFIG_HOME
    ? path.resolve(expandHome(env.XDG_CONFIG_HOME))
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "vibestudio", "npm-publish-token");
}

export function parseNpmToken(contents) {
  const line =
    contents
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry && !entry.startsWith("#")) ?? "";
  const match = /^(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*=\s*(.*)$/.exec(line);
  const value = (match ? match[1].trim() : line).replace(/^['"]|['"]$/g, "");
  if (value && !/^[\x21-\x7e]+$/.test(value))
    throw new Error("npm token contains invalid characters; replace it with pnpm setup:npm-token.");
  return value;
}

export function readNpmAuthToken({ env = process.env, savedOnly = false } = {}) {
  if (!savedOnly) {
    for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
      if (env[name]?.trim()) return { source: name, value: parseNpmToken(env[name]) };
    }
  }
  const file = npmTokenFilePath(env);
  if (!fs.existsSync(file)) return null;
  if (!fs.statSync(file).isFile()) throw new Error(`npm token path is not a file: ${file}`);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  const value = parseNpmToken(fs.readFileSync(file, "utf8"));
  if (!value) throw new Error(`npm token file is empty: ${file}`);
  return { source: file, value };
}

/** One operation owns its isolated npm config until all child commands have joined. */
export function createNpmAuth({ env = process.env, required = false } = {}) {
  const token = readNpmAuthToken({ env });
  if (required && !token) throw new Error("npm requires a saved token. Run pnpm setup:npm-token.");
  let directory;
  let closed = false;
  return {
    token,
    redact(value) {
      const text = String(value);
      return token ? text.split(token.value).join("[redacted]") : text;
    },
    environment() {
      if (closed) throw new Error("npm authentication operation is closed.");
      if (!token) return { ...env };
      if (!directory) {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-npm-auth-"));
        fs.writeFileSync(
          path.join(directory, ".npmrc"),
          "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n",
          { mode: 0o600 }
        );
      }
      return {
        ...env,
        NODE_AUTH_TOKEN: token.value,
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
        npm_config_registry: "https://registry.npmjs.org/",
        NPM_CONFIG_USERCONFIG: path.join(directory, ".npmrc"),
        npm_config_userconfig: path.join(directory, ".npmrc"),
      };
    },
    close() {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
      directory = undefined;
      closed = true;
    },
  };
}
