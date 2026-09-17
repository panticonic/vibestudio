import { parseWorkspaceSystemEpochEnvelope } from "@vibestudio/workspace/configParser";
import {
  composeDeclaredTemplateLayers,
  enumerateRootTemplateRepositories,
} from "../workspaceRootTemplateBootstrap.js";
import type { ExactGitSnapshot } from "@vibestudio/git";
import { Buffer } from "node:buffer";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { workspaceTemplateSourceMethods } from "@vibestudio/service-schemas/templates";
import type { TemplateRegistry } from "@vibestudio/service-schemas/templates";
import {
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
  validateTemplateSnapshotInventory,
} from "@vibestudio/workspace/templateManifest";
import {
  TEMPLATE_SOURCE_MANIFEST_PATH,
  normalizeTemplateGitUrl,
} from "@vibestudio/workspace/templateCoordinates";
import {
  sameWorkspaceTemplatePin,
  type WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import type { WorkspaceSource } from "@vibestudio/workspace-contracts/workspaceSource";

export async function acquireExactWorkspaceSource<T>(input: {
  pin: WorkspaceTemplatePin;
  sources: readonly WorkspaceSource[];
  fromCheckout(source: WorkspaceSource): Promise<T>;
  fromRemote(pin: WorkspaceTemplatePin): Promise<T>;
}): Promise<T> {
  const selected = input.sources.find((source) => sameWorkspaceTemplatePin(source.pin, input.pin));
  return selected ? input.fromCheckout(selected) : input.fromRemote(input.pin);
}

export function createWorkspaceTemplateSourceService(deps: {
  systemEpoch: number;
  acquire(pin: WorkspaceTemplatePin): Promise<ExactGitSnapshot>;
  resolveLocal(url: string): WorkspaceTemplatePin | null;
  localRegistry(): TemplateRegistry | null;
  resolveTrack?(address: {
    url: string;
    track: string;
    credential?: string;
  }): Promise<{ ref: string; commit: string }>;
  put(bytes: Uint8Array): Promise<unknown>;
}): ServiceDefinition {
  const acquireValidated = async (pin: WorkspaceTemplatePin) => {
    const snapshot = await deps.acquire(pin);
    const bytes = snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
    if (!bytes) throw new Error(`Upstream snapshot is missing ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
    const manifest = parseTemplateManifestContent(
      Buffer.from(bytes).toString("utf8"),
      deps.systemEpoch
    );
    rootRuntimeFromTemplateManifest(manifest);
    validateTemplateSnapshotInventory(
      manifest.inventory,
      snapshot.files.map((file) => file.path)
    );
    return { snapshot, manifest };
  };
  return {
    name: "workspaceTemplateSource",
    description: "Host-owned exact workspace source acquisition",
    authority: { principals: ["code", "host"] },
    methods: workspaceTemplateSourceMethods,
    handler: defineServiceHandler("workspaceTemplateSource", workspaceTemplateSourceMethods, {
      composeExact: async (ctx, [{ sources, purpose }]) => {
        requireReviewedSourceConsumer(ctx.caller);
        const root = sources.at(-1)!;
        const normalize = normalizeTemplateGitUrl;
        if (new Set(sources.map((source) => normalize(source.url))).size !== sources.length)
          throw new Error("Each installed template source must have one exact pin");
        const composed = await composeDeclaredTemplateLayers({
          pin: root,
          purpose,
          root: (await acquireValidated(root)).snapshot,
          expectedSystemEpoch: deps.systemEpoch,
          acquire: async (pin) => (await acquireValidated(pin)).snapshot,
          resolveTrack: async (address) => {
            const pinned = sources.find(
              (source) => normalize(source.url) === normalize(address.url)
            );
            if (pinned) return { ref: pinned.ref, commit: pinned.commit };
            if (!deps.resolveTrack) throw new Error("New template dependency cannot be resolved");
            return deps.resolveTrack(address);
          },
        });
        // Composition generates the metadata manifest; store it beside acquired
        // blobs so the native VCS receives content-addressed snapshots only.
        const manifestBytes = composed.snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
        if (!manifestBytes) throw new Error("Composed source lost its manifest");
        await deps.put(manifestBytes);
        return {
          sources: composed.layers,
          repositories: enumerateRootTemplateRepositories(composed.snapshot).map((repo) => ({
            repoPath: repo.repoPath,
            snapshot: repo.snapshot,
            files: repo.files.map((file) => ({
              path: file.path,
              contentHash: file.contentHash,
              mode: file.mode,
            })),
          })),
        };
      },
      localRegistry: async (ctx) => {
        requireReviewedSourceConsumer(ctx.caller);
        return deps.localRegistry();
      },
      resolveLocal: async (ctx, [url]) => {
        requireReviewedSourceConsumer(ctx.caller);
        return deps.resolveLocal(url);
      },
      readEpoch: async (ctx, [pin]) => {
        requireReviewedSourceConsumer(ctx.caller);
        const snapshot = await deps.acquire(pin);
        const bytes = snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
        if (!bytes)
          throw new Error(`Upstream snapshot is missing ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
        return parseWorkspaceSystemEpochEnvelope(Buffer.from(bytes).toString("utf8"));
      },
      inspectExact: async (ctx, [pin]) => {
        requireReviewedSourceConsumer(ctx.caller);
        const { manifest } = await acquireValidated(pin);
        return {
          pin,
          ...(manifest.presentation ? { presentation: manifest.presentation } : {}),
          repositories: manifest.inventory.repositories,
          dependencies: manifest.dependencies,
        };
      },
    }),
  };
}

function requireReviewedSourceConsumer(caller: {
  codeApproved?: boolean;
  code?: { callerId: string; repoPath: string };
  runtime: { kind: string; id: string };
}): void {
  const isReviewedExtension =
    caller.codeApproved === true &&
    caller.code?.callerId === caller.runtime.id &&
    caller.runtime.kind === "extension" &&
    caller.runtime.id === "@workspace-extensions/templates" &&
    caller.code.repoPath === "extensions/templates";
  const isAuthenticatedShell =
    caller.runtime.kind === "shell" && caller.runtime.id.startsWith("shell:");
  if (!isReviewedExtension && !isAuthenticatedShell)
    throw new Error("Exact source acquisition requires a reviewed source consumer");
}
