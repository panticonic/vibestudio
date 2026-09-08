import { Buffer } from "node:buffer";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { workspaceTemplateSourceMethods } from "@vibestudio/service-schemas/templates";
import {
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
  validateTemplateSnapshotInventory,
} from "@vibestudio/workspace/templateManifest";
import { TEMPLATE_SOURCE_MANIFEST_PATH } from "@vibestudio/workspace/templateCoordinates";
import {
  sameWorkspaceTemplatePin,
  type WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import type { WorkspaceSource } from "@vibestudio/workspace-contracts/workspaceSource";

interface ExactSnapshot {
  files: readonly { path: string }[];
  readFile(path: string): Uint8Array | null;
}

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
  acquire(pin: WorkspaceTemplatePin): Promise<ExactSnapshot>;
}): ServiceDefinition {
  return {
    name: "workspaceTemplateSource",
    description: "Host-owned exact workspace source acquisition",
    authority: { principals: ["code", "host"] },
    methods: workspaceTemplateSourceMethods,
    handler: defineServiceHandler("workspaceTemplateSource", workspaceTemplateSourceMethods, {
      inspectExact: async (ctx, [pin]) => {
        const caller = ctx.caller;
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
        const snapshot = await deps.acquire(pin);
        const bytes = snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
        if (!bytes) {
          throw new Error(`Upstream snapshot is missing ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
        }
        const manifest = parseTemplateManifestContent(
          Buffer.from(bytes).toString("utf8"),
          deps.systemEpoch
        );
        rootRuntimeFromTemplateManifest(manifest);
        const paths = snapshot.files.map((file) => file.path);
        validateTemplateSnapshotInventory(manifest.inventory, paths);
        return {
          pin,
          ...(manifest.presentation ? { presentation: manifest.presentation } : {}),
          repositories: manifest.inventory.repositories,
          files: manifest.inventory.files,
        };
      },
    }),
  };
}
