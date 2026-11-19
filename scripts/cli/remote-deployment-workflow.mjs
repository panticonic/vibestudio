import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { deploy, parseArgs, run, shellQuote, targetShell } from "./remote-deploy.mjs";

const NOT_VERIFIED = Object.freeze({ state: "unverified", identity: null });

/**
 * Project only the public identity attested by both the protected ready record
 * and live HTTP endpoints. This function also runs directly on an SSH target.
 */
export async function inspectDeploymentIdentity({
  fileSystem = fs,
  fetchImpl = fetch,
  readyFile,
  port,
  workspace = "default",
  active = true,
}) {
  const unverified = { state: active ? "unverified" : "inactive", identity: null };
  try {
    const file = fileSystem.lstatSync(readyFile);
    if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size > 1024 * 1024) return unverified;
    const ready = JSON.parse(fileSystem.readFileSync(readyFile, "utf8"));
    if (
      ready?.mode !== "hub" ||
      ready.gatewayPort !== port ||
      !/^srv_[A-Za-z0-9_-]{24}$/u.test(ready.serverId) ||
      !/^boot_[A-Za-z0-9_-]{24}$/u.test(ready.serverBootId) ||
      !/^[a-f0-9]{64}$/u.test(ready.buildId) ||
      !Number.isSafeInteger(ready.pid) ||
      ready.pid <= 0 ||
      !Array.isArray(ready.workspaces)
    )
      return unverified;
    const matching = ready.workspaces.filter(({ name }) => name === workspace);
    if (matching.length !== 1 || typeof matching[0].workspaceId !== "string") return unverified;
    const { workspaceId } = matching[0];
    if (!workspaceId) return unverified;
    const { serverId, serverBootId: bootId, buildId, pid } = ready;
    const identity = { serverId, bootId, buildId, workspaceId };
    if (!active) return { state: "inactive", identity };
    const signal = AbortSignal.timeout(5_000);
    const origin = `http://127.0.0.1:${port}`;
    const [hubResponse, childResponse] = await Promise.all([
      fetchImpl(origin + "/healthz", { signal, redirect: "error" }),
      fetchImpl(origin + `/_workspace/${encodeURIComponent(workspace)}/healthz`, {
        signal,
        redirect: "error",
      }),
    ]);
    if (!hubResponse.ok || !childResponse.ok) return unverified;
    const [hub, child] = await Promise.all([hubResponse.json(), childResponse.json()]);
    if (
      hub?.ok !== true ||
      hub.mode !== "hub" ||
      hub.serverId !== serverId ||
      hub.serverBootId !== bootId ||
      hub.gatewayPort !== port ||
      hub.buildId !== buildId ||
      hub.pid !== pid ||
      child?.ok !== true ||
      child.serverId !== serverId ||
      child.workspaceId !== workspaceId
    )
      return unverified;
    return { state: "ready", identity };
  } catch {
    return unverified;
  }
}

async function observeManagedTarget(options, runCommand, signal) {
  const script = `set -e
active=$(systemctl --user show --value --property=ActiveState vibestudio-server.service)
if [ "$active" = "active" ] || [ "$active" = "inactive" ]; then
  node -e ${shellQuote(`const fs=require('node:fs'); const inspect=(${inspectDeploymentIdentity.toString()});
    inspect({readyFile:process.argv[1],port:Number(process.argv[2]),active:process.argv[3]==='active'})
      .then(result=>process.stdout.write(JSON.stringify(result)+'\\n'));`)} "$HOME/.config/vibestudio/server-auth/hub-ready.json" ${options.port} "$active"
else
  printf '%s\\n' '{"state":"unverified","identity":null}'
fi`;
  try {
    const output = await targetShell(options.target, script, {
      run: runCommand,
      runOptions: { capture: true, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) },
    });
    const value = JSON.parse(output.trim());
    if (value.state === "inactive" && !value.identity) return { state: "inactive", identity: null };
    if (!["inactive", "ready"].includes(value.state) || !value.identity) return NOT_VERIFIED;
    const { serverId, bootId, buildId, workspaceId } = value.identity;
    if (
      ![serverId, bootId, buildId, workspaceId].every((entry) => typeof entry === "string" && entry)
    )
      return NOT_VERIFIED;
    return { state: value.state, identity: { serverId, bootId, buildId, workspaceId } };
  } catch {
    signal.throwIfAborted();
    return NOT_VERIFIED;
  }
}

function sameBaseline(before, current) {
  return (
    before.state === current.state &&
    (before.identity === current.identity ||
      (before.identity &&
        current.identity &&
        Object.keys(before.identity).every(
          (key) => before.identity[key] === current.identity[key]
        )))
  );
}

/** These capabilities apply a single host-authorized deploy or update. */
export function bindRemoteDeployment(
  argv,
  { run: runCommand = run, signal = new AbortController().signal } = {}
) {
  const options = parseArgs([...argv]);
  if (options.help || !options.target || !["deploy", "update"].includes(options.verb))
    throw new Error("Assign one explicit Vibestudio deployment target and operation");
  const operationId = randomUUID();
  const receipt = (stage) => `${operationId}:${stage}`;
  let phase = "start";
  let baseline;
  let verified;

  function claim(expectedPhase, supplied, expectedReceipt) {
    signal.throwIfAborted();
    if (phase !== expectedPhase || supplied !== expectedReceipt)
      throw new Error("The deployment receipt does not belong to the current attempt");
    phase = "terminal";
  }
  return {
    request: { operationId },
    /** Trusted caller only. Consume a readiness receipt and verify the same live identity again. */
    async takeVerifiedIdentity(deploymentReceipt) {
      const reuse = phase === "observed" && options.verb === "deploy" && baseline.state === "ready";
      if (reuse) {
        claim("observed", deploymentReceipt, receipt("baseline"));
      } else {
        claim("verified", deploymentReceipt, receipt("verification"));
      }
      const current = await observeManagedTarget(options, runCommand, signal);
      return sameBaseline(reuse ? baseline : verified, current) ? current.identity : null;
    },
    services: {
      remoteDeploymentRead: {
        async observe(id) {
          claim("start", id, operationId);
          baseline = await observeManagedTarget(options, runCommand, signal);
          phase = "observed";
          return {
            receipt: receipt("baseline"),
            intent: options.verb,
            state: baseline.state,
            hasPriorIdentity: Boolean(baseline.identity),
          };
        },
      },
      remoteDeploymentApply: {
        async apply(baselineReceipt) {
          claim("observed", baselineReceipt, receipt("baseline"));
          const canApply =
            options.verb === "deploy"
              ? baseline.state === "inactive"
              : baseline.state !== "unverified" && baseline.identity !== null;
          if (!canApply)
            throw new Error("The observed deployment does not admit the assigned installer");
          const result = { receipt: receipt("apply") };
          const current = await observeManagedTarget(options, runCommand, signal);
          if (!sameBaseline(baseline, current)) return { ...result, state: "baseline-changed" };
          try {
            await deploy(options, {
              run: (command, args, runOptions) =>
                runCommand(command, args, { ...runOptions, signal }),
              showPairing: false,
            });
            phase = "applied";
            return { ...result, state: "applied" };
          } catch {
            signal.throwIfAborted();
            return { ...result, state: "failed" };
          }
        },
      },
      remoteDeploymentVerify: {
        async verify(actionReceipt) {
          claim("applied", actionReceipt, receipt("apply"));
          const current = await observeManagedTarget(options, runCommand, signal);
          const result = { receipt: receipt("verification"), identity: null };
          if (current.state !== "ready") return { ...result, state: "unready" };
          if (
            baseline.identity &&
            (baseline.identity.serverId !== current.identity.serverId ||
              baseline.identity.workspaceId !== current.identity.workspaceId)
          )
            return { ...result, state: "identity-changed" };
          if (baseline.identity?.bootId === current.identity.bootId)
            return { ...result, state: "unchanged-boot" };
          verified = current;
          phase = "verified";
          return { ...result, state: "verified", identity: { ...current.identity } };
        },
      },
    },
  };
}
