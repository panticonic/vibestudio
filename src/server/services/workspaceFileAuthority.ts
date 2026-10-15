import { taxonomyRepoForPath } from "@vibestudio/shared/runtime/entitySpec";
import { resourceScopeContains } from "@vibestudio/shared/authorization";
import {
  fixedPreparedAuthoritySelection,
  type FixedPreparedAuthoritySelection,
} from "@vibestudio/shared/serviceDefinition";
import {
  workspaceFileResource,
  type WorkspaceFileAccess,
} from "@vibestudio/shared/authority/workspaceFiles";

export function workspaceFileSelection(
  access: WorkspaceFileAccess
): FixedPreparedAuthoritySelection {
  access = consentAccess(access);
  const resource = workspaceFileResource(access);
  const folder = access.kind === "folder";
  const repository = taxonomyRepoForPath(access.path) === access.path;
  const logicalPath = access.path.replace(/\/+$/, "");
  const value = logicalPath ? `/${logicalPath}${folder ? "/" : ""}` : "/";
  const object = {
    type: repository ? "workspace-repository" : folder ? "workspace-folder" : "workspace-file",
    label: repository ? "Repository" : folder ? "Folder" : "File",
    value,
  };
  const action =
    access.effect === "list"
      ? "list files and folders"
      : access.effect === "read"
        ? "read file contents"
        : "create, change, and delete files";
  const description =
    access.effect === "list"
      ? "Shows file and folder names in this part of the workspace. This does not allow reading file contents or changing files."
      : access.effect === "read"
        ? `Shares contents of ${repository ? "all files in this repository" : folder ? "files in this folder and its subfolders" : "this file"} with the website and agents it starts.`
        : `Allows the website and agents it starts to create, change, and delete ${repository ? "all files in this repository" : folder ? "files in this folder and its subfolders" : "this file"}.`;
  return fixedPreparedAuthoritySelection({
    capability: `filesystem.${access.effect}`,
    resourceKey: resource.kind === "prefix" ? resource.prefix : resource.key,
    resource,
    challenge: {
      title: !access.path
        ? access.effect === "list"
          ? "Show this website the workspace structure?"
          : access.effect === "read"
            ? "Read all workspace files?"
            : "Change all workspace files?"
        : `${access.effect === "list" ? "List" : access.effect === "read" ? "Read" : "Change"} ${value}?`,
      description,
      deniedReason: `Access to ${value} was not allowed`,
      resource: object,
      operation: { kind: "unknown" as const, verb: action, object },
    },
  });
}

/** Consent follows the workspace repository taxonomy, shared by fs and VCS.
 * Keep execution coordinates exact: disk path binding must still detect a
 * symlink target changing after preparation, even inside an approved repo.
 * Browsing a repo is part of reading it, so metadata and contents share consent.
 */
function consentAccess(access: WorkspaceFileAccess): WorkspaceFileAccess {
  const path = access.path.replace(/\/+$/, "");
  const repo = taxonomyRepoForPath(path);
  return repo
    ? { effect: access.effect === "list" ? "read" : access.effect, path: repo, kind: "folder" }
    : { ...access, path };
}

export function workspaceFileSelections(
  accesses: readonly WorkspaceFileAccess[]
): FixedPreparedAuthoritySelection[] {
  const unique = [
    ...new Map(
      accesses.map((access) => {
        const normalized = consentAccess(access);
        return [JSON.stringify(normalized), normalized] as const;
      })
    ).values(),
  ];
  return unique
    .filter(
      (access, index) =>
        !unique.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.effect === access.effect &&
            resourceScopeContains(workspaceFileResource(other), workspaceFileResource(access))
        )
    )
    .sort((a, b) => `${a.effect}:${a.path}`.localeCompare(`${b.effect}:${b.path}`))
    .map(workspaceFileSelection);
}
