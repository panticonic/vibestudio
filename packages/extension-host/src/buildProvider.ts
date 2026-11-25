import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  BuildProvider,
  BuildProviderOutput,
  BuildProviderTarget,
} from "@vibestudio/shared/buildProvider";
import type { ExtensionInvocation } from "./types.js";

/** One provider adapter for live extensions and the owned release producer. */
export function createExtensionBuildProvider(
  identity: { name: string; activeEv: string | null; activeBuildKey: string | null },
  target: BuildProviderTarget,
  transport: {
    call(name: string, method: string, args: unknown[]): Promise<unknown>;
    streamCallTarget?(name: string, method: string, ...args: unknown[]): Promise<Response>;
  }
): BuildProvider {
  return {
    name: identity.name,
    target,
    contractVersion: "vibestudio-build-provider-v2",
    activeEv: identity.activeEv,
    activeBuildKey: identity.activeBuildKey,
    build: async (input) => {
      const invocation: ExtensionInvocation = {
        requestId: randomUUID(),
        extensionName: identity.name,
        method: "build",
        caller: {
          callerId: "server:build-system",
          callerKind: "server",
        },
      };
      const output = await transport.call(identity.name, "extension.invoke", [
        "build",
        [input],
        invocation,
      ]);
      return assertBuildProviderOutput(identity.name, target, output);
    },
    streamArtifact: async (artifact, input) => {
      if (!artifact.stream) {
        throw new Error(
          `Build provider ${identity.name} artifact ${artifact.path} is not stream-backed`
        );
      }
      if (!transport.streamCallTarget) {
        throw new Error(`Build provider ${identity.name} streaming transport is unavailable`);
      }
      const invocation: ExtensionInvocation = {
        requestId: randomUUID(),
        extensionName: identity.name,
        method: artifact.stream.method,
        caller: {
          callerId: "server:build-system",
          callerKind: "server",
        },
      };
      return transport.streamCallTarget(
        identity.name,
        "extension.invokeStream",
        artifact.stream.method,
        artifact.stream.args ?? [artifact.path, input],
        invocation
      );
    },
  };
}

export function extensionPrimaryArtifactPath(build: {
  dir: string;
  artifacts: { path: string; role: string; platform?: string }[];
}): string {
  const artifact =
    build.artifacts.find((entry) => entry.role === "primary" && entry.platform === undefined) ??
    build.artifacts.find((entry) => entry.role === "primary");
  if (!artifact) {
    throw new Error("Extension build has no primary artifact");
  }
  if (path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid extension build artifact path: ${artifact.path}`);
  }
  return path.join(build.dir, artifact.path);
}

function assertBuildProviderOutput(
  providerName: string,
  target: BuildProviderTarget,
  value: unknown
): BuildProviderOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Build provider ${providerName} for ${target} returned a non-object output`);
  }
  const output = value as Partial<BuildProviderOutput>;
  if (
    !Array.isArray(output.artifacts) ||
    output.artifacts.some(
      (artifact) =>
        !artifact ||
        typeof artifact !== "object" ||
        typeof artifact.path !== "string" ||
        typeof artifact.role !== "string" ||
        typeof artifact.contentType !== "string" ||
        (typeof artifact.content !== "string" && !isBuildProviderArtifactStream(artifact.stream)) ||
        (artifact.encoding !== undefined &&
          artifact.encoding !== "utf8" &&
          artifact.encoding !== "base64")
    )
  ) {
    throw new Error(`Build provider ${providerName} for ${target} returned invalid artifacts`);
  }
  return { artifacts: output.artifacts };
}

function isBuildProviderArtifactStream(
  value: unknown
): value is { method: string; args?: unknown[]; integrity: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stream = value as { method?: unknown; args?: unknown; integrity?: unknown };
  return (
    typeof stream.method === "string" &&
    stream.method.trim().length > 0 &&
    typeof stream.integrity === "string" &&
    /^sha256-[0-9a-f]{64}$/.test(stream.integrity) &&
    (stream.args === undefined || Array.isArray(stream.args))
  );
}
