import * as path from "node:path";
import {
  vcsMethods,
  type VcsMethodName,
  type VcsStateNodeRef,
  type VcsInspectInput,
  type VcsCompareInput,
  type VcsStatusInput,
  type VcsSemanticNodeRef,
  type VcsListDirectoryInput,
  type VcsListFilesInput,
  type VcsInspectResult,
  type VcsCompareResult,
  type VcsStatusResult,
  type VcsListDirectoryResult,
  type VcsListFilesResult,
} from "@vibestudio/service-schemas/vcs";
import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceFileAccess } from "@vibestudio/shared/authority/workspaceFiles";
import { workspaceFileSelections } from "./workspaceFileAuthority.js";

export interface SemanticReads {
  inspect(input: VcsInspectInput): Promise<VcsInspectResult>;
  compare(input: VcsCompareInput): Promise<VcsCompareResult>;
  status(input: VcsStatusInput): Promise<VcsStatusResult>;
  listDirectory(input: VcsListDirectoryInput): Promise<VcsListDirectoryResult>;
  listFiles(input: VcsListFilesInput): Promise<VcsListFilesResult>;
}

/** Select paths from authoritative identities at the exact admitted semantic state. */
export async function vcsFileSelections(
  method: VcsMethodName,
  input: unknown,
  read: SemanticReads
) {
  const accesses: WorkspaceFileAccess[] = [];
  const inspectNode = (node: VcsSemanticNodeRef) => read.inspect({ node, edgeLimit: 1 });
  const inspect = (
    state: VcsStateNodeRef,
    kind: "repository" | "file",
    identity: string,
    repositoryId?: string
  ) =>
    inspectNode(
      kind === "repository"
        ? { kind, state, repositoryId: identity }
        : { kind, state, repositoryId: repositoryId!, fileId: identity }
    );
  const add = (
    effect: WorkspaceFileAccess["effect"],
    logicalPath: string,
    kind: WorkspaceFileAccess["kind"] = "file"
  ) => {
    const normalized = path.posix.normalize(logicalPath.replaceAll("\\", "/").replace(/^\/+/, ""));
    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("\0"))
      throw new ServiceError("vcs", method, "Path traversal detected", "EACCES");
    accesses.push({ effect, path: normalized === "." ? "" : normalized.replace(/\/+$/, ""), kind });
  };
  const repository = async (state: VcsStateNodeRef, id: string) => {
    const result = await inspect(state, "repository", id);
    if (result.node.kind !== "repository" || result.node.value.kind !== "present")
      throw new ServiceError(
        "vcs",
        method,
        "Repository is not present at the requested state",
        "EINVAL"
      );
    return result.node.value.repoPath;
  };
  const file = async (state: VcsStateNodeRef, repoId: string, fileId: string) => {
    const result = await inspect(state, "file", fileId, repoId);
    if (
      result.node.kind !== "file" ||
      result.node.value.kind !== "placed" ||
      result.node.value.repositoryId !== repoId
    )
      throw new ServiceError(
        "vcs",
        method,
        "File is not present in the requested repository and state",
        "EINVAL"
      );
    return `${await repository(state, repoId)}/${result.node.value.path}`;
  };
  async function* repositories(state: VcsStateNodeRef) {
    const directories = [""];
    for (const directory of directories) {
      let cursor: string | undefined;
      do {
        const page = await read.listDirectory({
          state,
          path: directory,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of page?.entries ?? []) {
          if (entry.repositoryRoot && entry.repositoryId)
            yield { repositoryId: entry.repositoryId, path: entry.path };
          else if (entry.kind === "directory") directories.push(entry.path);
        }
        cursor = page?.nextCursor ?? undefined;
      } while (cursor);
    }
  }
  async function findFile(state: VcsStateNodeRef, repositoryId: string, fileId: string) {
    let cursor: string | undefined;
    do {
      const page = await read.listFiles({
        state,
        repositoryId,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      const found = page.files.find((file) => file.fileId === fileId);
      if (found) return found.path;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return null;
  }
  const fileByIdentity = async (state: VcsStateNodeRef, fileId: string) => {
    for await (const repo of repositories(state)) {
      const found = await findFile(state, repo.repositoryId, fileId);
      if (found !== null) return `${repo.path}/${found}`;
    }
    throw new ServiceError("vcs", method, "File is not placed in the requested state", "EINVAL");
  };
  switch (method) {
    case "mainState":
    case "status":
      add("list", "", "folder");
      break;
    case "resolveRepository": {
      const [request] = vcsMethods.resolveRepository.args.parse([input]);
      add("list", request.repoPath, "folder");
      break;
    }
    case "listDirectory": {
      const [request] = vcsMethods.listDirectory.args.parse([input]);
      add("list", request.path, "folder");
      break;
    }
    case "listFiles": {
      const [request] = vcsMethods.listFiles.args.parse([input]);
      // This API accepts a lexical filename prefix, not a directory. Its
      // containing folder covers every match, including similarly named files.
      const prefix = request.prefix ?? "";
      const parent = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      add("list", `${await repository(request.state, request.repositoryId)}/${parent}`, "folder");
      break;
    }
    case "readFile": {
      const [request] = vcsMethods.readFile.args.parse([input]);
      // Absent identities return null. Resolve names from metadata without
      // turning that valid result into a semantic inspect failure.
      let repoPath: string | null = null;
      for await (const repo of repositories(request.state)) {
        if (repo.repositoryId === request.repositoryId) {
          repoPath = repo.path;
          break;
        }
      }
      if (repoPath === null) add("list", "", "folder");
      else {
        const filePath =
          request.file.kind === "path"
            ? request.file.path
            : await findFile(request.state, request.repositoryId, request.file.fileId);
        if (filePath === null) add("list", repoPath, "folder");
        else add("read", `${repoPath}/${filePath}`);
      }
      break;
    }
    case "readMemory": {
      const [request] = vcsMethods.readMemory.args.parse([input]);
      add("read", request.path);
      break;
    }
    case "blame": {
      const [request] = vcsMethods.blame.args.parse([input]);
      add("read", await file(request.state, request.repositoryId, request.fileId));
      break;
    }
    case "edit": {
      const [request] = vcsMethods.edit.args.parse([input]);
      for (const change of request.changes) {
        if (change.kind === "repository-create") {
          add("write", change.repoPath, "folder");
        } else if (change.kind === "repository-delete") {
          add(
            "write",
            await repository(request.expectedWorkingHead, change.repositoryId),
            "folder"
          );
        } else if (change.kind === "file-create") {
          add(
            "write",
            `${await repository(request.expectedWorkingHead, change.repositoryId)}/${change.path}`
          );
        } else {
          add("write", await file(request.expectedWorkingHead, change.repositoryId, change.fileId));
        }
      }
      break;
    }
    case "move": {
      const [request] = vcsMethods.move.args.parse([input]);
      for (const move of request.moves) {
        if (move.kind === "repository") {
          add("write", await repository(request.expectedWorkingHead, move.repositoryId), "folder");
          add("write", move.destinationPath, "folder");
        } else {
          add("write", await file(request.expectedWorkingHead, move.repositoryId, move.fileId));
          add(
            "write",
            `${await repository(request.expectedWorkingHead, move.destinationRepositoryId)}/${move.destinationPath}`
          );
        }
      }
      break;
    }
    case "copy": {
      const [request] = vcsMethods.copy.args.parse([input]);
      for (const copy of request.copies) {
        add("read", await file(copy.source.state, copy.source.repositoryId, copy.source.fileId));
        add(
          "write",
          `${await repository(request.expectedWorkingHead, copy.destination.repositoryId)}/${copy.destination.path}`
        );
      }
      break;
    }
    case "importSnapshot": {
      const [request] = vcsMethods.importSnapshot.args.parse([input]);
      for (const repo of request.repositories) add("write", repo.repoPath, "folder");
      break;
    }
    // Graph queries and whole-state operations are explicitly workspace-wide.
    // Tree consent must never authorize their recorded prose or mutations.
    case "compare":
    case "inspect":
    case "neighbors":
    case "history":
    case "walk":
    case "query":
    case "search":
      add("read", "", "folder");
      break;
    case "commit":
      // A commit records the already-authorized working state; it does not
      // change its file contents or disclose them to the requester.
      break;
    case "merge":
    case "discard":
    case "push": {
      let target: VcsStateNodeRef;
      let source: VcsStateNodeRef | { kind: "external-delta"; deltaId: string };
      let selected: Set<string> | undefined;
      if (method === "merge") {
        const [request] = vcsMethods.merge.args.parse([input]);
        target = request.expectedWorkingHead;
        source = request.source;
        if (request.coordinates || Array.isArray(request.resolutions)) {
          selected = new Set(
            [
              ...(request.coordinates ?? []),
              ...(Array.isArray(request.resolutions)
                ? request.resolutions.map((resolution) => resolution.coordinate)
                : []),
            ].map((coordinate) => `${coordinate.kind}:${coordinate.id}`)
          );
        }
      } else if (method === "discard") {
        const [request] = vcsMethods.discard.args.parse([input]);
        const status = await read.status({ contextId: request.contextId });
        target = status.committed;
        source = request.expectedWorkingHead;
      } else {
        const [request] = vcsMethods.push.args.parse([input]);
        target = { kind: "event", eventId: request.expectedMainEventId };
        source = { kind: "event", eventId: request.expectedCommittedEventId };
      }
      let cursor: string | undefined;
      do {
        const comparison = await read.compare({
          target,
          source,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of comparison.coordinates) {
          if (selected && !selected.has(`${entry.coordinate.kind}:${entry.coordinate.id}`))
            continue;
          for (const logicalPath of Object.values(entry.coordinate.paths)) {
            add("write", logicalPath, entry.coordinate.kind === "repository" ? "folder" : "file");
          }
        }
        cursor = comparison.nextCursor ?? undefined;
      } while (cursor);
      break;
    }
    case "revert": {
      const [request] = vcsMethods.revert.args.parse([input]);
      const changes = await Promise.all(
        request.changeIds.map(async (changeId) => {
          const inspected = await inspectNode({ kind: "change", changeId });
          if (inspected.node.kind !== "change")
            throw new ServiceError("vcs", method, "Change identity is invalid", "EINVAL");
          return inspected.node.value.effects;
        })
      );
      const effects = changes.flat();
      const restoredRepositories = new Map(
        effects
          .filter((effect) => effect.kind === "repository-placement" && effect.beforePath)
          .map((effect) =>
            effect.kind === "repository-placement"
              ? [effect.repositoryId, effect.beforePath!]
              : ["", ""]
          )
      );
      const repoPath = async (id: string) =>
        restoredRepositories.get(id) ?? (await repository(request.expectedWorkingHead, id));
      for (const effect of effects) {
        if (effect.kind === "repository-placement") {
          if (effect.beforePath) add("write", effect.beforePath, "folder");
          if (effect.afterPath) add("write", effect.afterPath, "folder");
        } else if (effect.kind === "placement") {
          for (const placement of [effect.before, effect.after]) {
            if (placement)
              add("write", `${await repoPath(placement.repositoryId)}/${placement.path}`);
          }
        } else if (
          !effects.some(
            (placement) => placement.kind === "placement" && placement.fileId === effect.fileId
          )
        ) {
          add("write", await fileByIdentity(request.expectedWorkingHead, effect.fileId));
        }
      }
      break;
    }
    case "registerExternalDelta":
    case "supersedeExternalDelta":
    case "finalizeExternalDelta":
      throw new ServiceError("vcs", method, "This operation is closed to websites", "EACCES");
    default: {
      const exhaustive: never = method;
      throw new Error(`Workspace file authority is undeclared for ${exhaustive}`);
    }
  }
  return workspaceFileSelections(accesses);
}
