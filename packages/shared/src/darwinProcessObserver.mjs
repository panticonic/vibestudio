import { spawnSync } from "node:child_process";
import path from "node:path";

const MEMBER_KEYS = ["command", "pgid", "pid", "ppid", "startCoordinate", "state", "uid"];

export function resolveDarwinProcessObserverPath(
  appRoot = process.env["VIBESTUDIO_APP_ROOT"],
  arch = process.arch
) {
  if (typeof appRoot !== "string" || appRoot.length === 0) {
    throw Object.assign(
      new Error("VIBESTUDIO_APP_ROOT is required for Darwin process observation"),
      {
        code: "EOWNERSHIP",
      }
    );
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw Object.assign(new Error("Unsupported Darwin process observer architecture: " + arch), {
      code: "EOWNERSHIP",
    });
  }
  if (appRoot.endsWith(".asar")) {
    return path.join(path.dirname(path.dirname(appRoot)), "MacOS", "owned-process-group-observer");
  }
  const physicalRoot = appRoot;
  return path.join(
    physicalRoot,
    "dist",
    "native-process-observer",
    "darwin-" + arch,
    "owned-process-group-observer"
  );
}

export function readDarwinProcessGroupSnapshot(
  processGroupId,
  leaderPid,
  { observerPath = resolveDarwinProcessObserverPath(), run = spawnSync } = {}
) {
  const result = run(observerPath, [String(processGroupId), String(leaderPid)], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw Object.assign(
      new Error(
        detail
          ? "Darwin process observer failed: " + detail
          : "Darwin process observer exited with status " + String(result.status)
      ),
      { code: "EOWNERSHIP" }
    );
  }
  const snapshot = parseDarwinProcessGroupSnapshot(result.stdout, processGroupId);
  if (snapshot.leader && snapshot.leader.pid !== leaderPid) {
    throw Object.assign(new Error("Darwin process observer returned the wrong leader"), {
      code: "EOWNERSHIP",
    });
  }
  return snapshot;
}

export function parseDarwinProcessGroupSnapshot(value, expectedProcessGroupId) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw Object.assign(new Error("Darwin process observer returned malformed JSON", { cause }), {
      code: "EOWNERSHIP",
    });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.version !== 1 ||
    parsed.processGroupId !== expectedProcessGroupId ||
    !Number.isSafeInteger(parsed.activeMemberCount) ||
    parsed.activeMemberCount < 0 ||
    typeof parsed.truncated !== "boolean" ||
    !Array.isArray(parsed.members) ||
    parsed.members.length > 64
  ) {
    throw Object.assign(new Error("Darwin process observer returned an invalid group snapshot"), {
      code: "EOWNERSHIP",
    });
  }
  const leader = parsed.leader === null ? null : parseMember(parsed.leader);
  const members = parsed.members.map(parseMember);
  if (
    leader &&
    leader.pgid === expectedProcessGroupId &&
    leader.state !== "Z" &&
    parsed.activeMemberCount === 0
  ) {
    throw Object.assign(
      new Error("Darwin process observer omitted an active process-group leader"),
      { code: "EOWNERSHIP" }
    );
  }
  if (members.some((member) => member.pgid !== expectedProcessGroupId)) {
    throw Object.assign(new Error("Darwin process observer returned a foreign group member"), {
      code: "EOWNERSHIP",
    });
  }
  if (parsed.activeMemberCount < members.filter((member) => member.state !== "Z").length) {
    throw Object.assign(
      new Error("Darwin process observer underreported active process-group members"),
      { code: "EOWNERSHIP" }
    );
  }
  if (
    !parsed.truncated &&
    parsed.activeMemberCount > members.filter((member) => member.state !== "Z").length
  ) {
    throw Object.assign(
      new Error("Darwin process observer omitted process-group members without truncation"),
      { code: "EOWNERSHIP" }
    );
  }
  return {
    processGroupId: expectedProcessGroupId,
    leader,
    activeMemberCount: parsed.activeMemberCount,
    members,
    truncated: parsed.truncated,
  };
}

function parseMember(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Darwin process observer returned an invalid process record"), {
      code: "EOWNERSHIP",
    });
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== MEMBER_KEYS.length ||
    keys.some((key, index) => key !== MEMBER_KEYS[index]) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isSafeInteger(value.ppid) ||
    value.ppid < 0 ||
    !Number.isSafeInteger(value.pgid) ||
    value.pgid < 0 ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    typeof value.state !== "string" ||
    value.state.length === 0 ||
    typeof value.startCoordinate !== "string" ||
    !/^\d+\.\d{6}$/u.test(value.startCoordinate) ||
    typeof value.command !== "string" ||
    value.command.length > 128
  ) {
    throw Object.assign(new Error("Darwin process observer returned an invalid process record"), {
      code: "EOWNERSHIP",
    });
  }
  return value;
}
