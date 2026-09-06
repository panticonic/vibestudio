import path from "node:path";

/** Resolved kernel resources, supplied by the installed authority owner. This
 * is an enforcement contract, not a permission request or approval document. */
export interface ExecutionPolicy {
  version: 1;
  owner: {
    workspaceId: string;
    contextId: string | null;
    runtimeId: string;
    incarnation: string;
    executionDigest: string;
  };
  executable: string;
  /** Exclusive workspace-owned domain directory. */
  privateRoot: string;
  args: readonly string[];
  cwd: string;
  home: string;
  environment: Readonly<Record<string, string>>;
  /** System runtime closure and admitted immutable inputs. */
  read: readonly string[];
  /** Private state/scratch owned exclusively by this execution domain. */
  write: readonly string[];
  /** Connected IPC must be explicitly supplied; there is no native IP grant. */
  sockets: readonly string[];
}

export class IsolationError extends Error {
  readonly code = "EISOLATION";
}

export function containsPath(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative))
  );
}

function hasControlByte(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 32) return true;
  }
  return false;
}

/** Validate before creating files, changing ACLs or starting any executable.
 * Filesystem anchoring and admission identity are also checked by the owner;
 * lexical validation alone cannot establish resource authorization. */
export function validateExecutionPolicy(policy: ExecutionPolicy, platform: NodeJS.Platform): void {
  if (policy.version !== 1) throw new IsolationError("Unsupported execution policy version");
  for (const [name, value] of Object.entries(policy.owner)) {
    if (name === "contextId" && value === null) continue;
    if (typeof value !== "string" || value.length === 0 || hasControlByte(value)) {
      throw new IsolationError(`Execution owner has an invalid ${name}`);
    }
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  for (const value of [
    policy.privateRoot,
    policy.executable,
    policy.cwd,
    policy.home,
    ...policy.read,
    ...policy.write,
    ...policy.sockets,
  ]) {
    if (
      typeof value !== "string" ||
      hasControlByte(value) ||
      !paths.isAbsolute(value) ||
      paths.normalize(value) !== value
    ) {
      throw new IsolationError("Execution resources must be canonical absolute paths");
    }
    if (value === paths.parse(value).root)
      throw new IsolationError("An execution cannot acquire the host filesystem root");
    if (platform === "win32" && (/^\\\\/u.test(value) || value.slice(2).includes(":"))) {
      throw new IsolationError(
        "UNC, device paths and alternate data streams are not execution resources"
      );
    }
  }
  for (const resource of policy.write) {
    if (!containsPath(policy.privateRoot, resource, platform) || resource === policy.privateRoot) {
      throw new IsolationError(
        "Writable resources must be strict descendants of the private domain root"
      );
    }
  }
  if (!policy.write.some((root) => containsPath(root, policy.home, platform))) {
    throw new IsolationError("Execution home must belong to private writable state");
  }
  if (![...policy.read, ...policy.write].some((root) => containsPath(root, policy.cwd, platform))) {
    throw new IsolationError("Execution working directory is not an admitted resource");
  }
  if (!policy.read.some((root) => containsPath(root, policy.executable, platform))) {
    throw new IsolationError("Initial executable is not in the admitted runtime closure");
  }
  for (const writable of policy.write) {
    for (const readonly of policy.read) {
      if (
        containsPath(writable, readonly, platform) ||
        containsPath(readonly, writable, platform)
      ) {
        throw new IsolationError("Immutable inputs and writable state must be disjoint");
      }
    }
  }
  for (const arg of policy.args) {
    if (typeof arg !== "string" || arg.includes("\0"))
      throw new IsolationError("Invalid execution argument");
  }
  for (const [key, value] of Object.entries(policy.environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw new IsolationError("Invalid execution environment");
    }
    if (
      /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMP|TEMP|TMPDIR|XDG_.*|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/iu.test(
        key
      )
    ) {
      throw new IsolationError(`Execution environment cannot override ${key}`);
    }
  }
}

export function executionEnvironment(
  policy: ExecutionPolicy,
  platform: NodeJS.Platform
): Record<string, string> {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return {
    ...policy.environment,
    // MXC's Unix executor resolves its shell through the guest PATH. Its
    // platform runtime baseline supplies these system tools.
    ...(platform === "win32"
      ? {}
      : { PATH: [policy.environment["PATH"], "/usr/bin", "/bin"].filter(Boolean).join(":") }),
    HOME: policy.home,
    USERPROFILE: policy.home,
    XDG_CONFIG_HOME: paths.join(policy.home, "config"),
    XDG_CACHE_HOME: paths.join(policy.home, "cache"),
    XDG_DATA_HOME: paths.join(policy.home, "data"),
    XDG_STATE_HOME: paths.join(policy.home, "state"),
    APPDATA: paths.join(policy.home, "config"),
    LOCALAPPDATA: paths.join(policy.home, "data"),
    TMPDIR: paths.join(policy.home, "tmp"),
    TMP: paths.join(policy.home, "tmp"),
    TEMP: paths.join(policy.home, "tmp"),
  };
}
