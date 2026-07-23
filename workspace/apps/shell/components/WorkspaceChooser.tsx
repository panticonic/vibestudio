import { useState, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  AlertDialog,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  IconButton,
  Spinner,
  Text,
} from "@radix-ui/themes";
import { ExclamationTriangleIcon, PlusIcon, TrashIcon } from "@radix-ui/react-icons";
import { Surface, VibestudioLogo } from "@workspace/ui";

import {
  recentWorkspacesAtom,
  workspacesLoadingAtom,
  activeWorkspaceNameAtom,
  loadRecentWorkspacesAtom,
  removeRecentWorkspaceAtom,
  chooseWorkspaceAtom,
  workspaceChooserDialogOpenAtom,
  wizardDialogOpenAtom,
  wizardFormDataAtom,
  workspaceErrorAtom,
  remoteWorkspaceModeAtom,
} from "../state/appModeAtoms";
import type { WorkspaceEntry } from "@vibestudio/shared/types";
import { HostTargetsSection } from "./HostTargetsSection";

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function WorkspaceChooser() {
  const recentWorkspaces = useAtomValue(recentWorkspacesAtom);
  const isLoading = useAtomValue(workspacesLoadingAtom);
  const activeWorkspaceName = useAtomValue(activeWorkspaceNameAtom);
  const loadRecentWorkspaces = useSetAtom(loadRecentWorkspacesAtom);
  const removeRecentWorkspace = useSetAtom(removeRecentWorkspaceAtom);
  const chooseWorkspace = useSetAtom(chooseWorkspaceAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const setWizardDialogOpen = useSetAtom(wizardDialogOpenAtom);
  const setWizardFormData = useSetAtom(wizardFormDataAtom);
  const workspaceError = useAtomValue(workspaceErrorAtom);
  const remoteWorkspaceMode = useAtomValue(remoteWorkspaceModeAtom);
  const setWorkspaceError = useSetAtom(workspaceErrorAtom);

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Load workspaces on mount. The atom owns clearing or replacing stale errors.
  useEffect(() => {
    void loadRecentWorkspaces();
  }, [loadRecentWorkspaces]);

  const handleChooseWorkspace = async (ws: WorkspaceEntry) => {
    if (ws.name === activeWorkspaceName) {
      setWorkspaceChooserOpen(false);
      return;
    }
    if (remoteWorkspaceMode) {
      setWorkspaceError(
        "Switch workspaces on the remote host, then pair this desktop with the target workspace."
      );
      return;
    }
    try {
      await chooseWorkspace(ws.name);
    } catch (error) {
      console.error("Failed to choose workspace:", error);
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRemoveWorkspace = (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    setPendingDelete(name);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const name = pendingDelete;
    setPendingDelete(null);
    await removeRecentWorkspace(name);
  };

  const handleCreateNew = () => {
    setWizardFormData({
      workspaceName: "",
      forkFrom: "",
    });
    setWizardDialogOpen(true);
  };

  return (
    <Box
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "24px",
        paddingTop: "40px", // Account for title bar
      }}
    >
      {/* Header */}
      <Flex direction="column" align="center" gap="2" mb="5">
        <VibestudioLogo size={156} variant="logo" />
        <Text size="2" color="gray">
          Select a workspace to get started
        </Text>
      </Flex>

      {/* Workspaces */}
      <Surface
        level="panel"
        bordered
        padding="4"
        flex={1}
        style={{ overflow: "hidden", minHeight: 0 }}
      >
        <Flex direction="column" style={{ height: "100%" }}>
          <Flex justify="between" align="center" mb="3">
            <Text size="2" weight="medium" color="gray">
              Workspaces
            </Text>
            {isLoading && (
              <Text size="1" color="gray">
                Loading...
              </Text>
            )}
          </Flex>

          {/* Error display */}
          {workspaceError && (
            <Callout.Root
              color="red"
              mb="2"
              style={{ cursor: "pointer" }}
              onClick={() => setWorkspaceError(null)}
            >
              <Callout.Icon>
                <ExclamationTriangleIcon />
              </Callout.Icon>
              <Callout.Text>{workspaceError}</Callout.Text>
            </Callout.Root>
          )}

          <Box
            style={{
              flex: 1,
              overflow: "auto",
              marginRight: "-8px",
              paddingRight: "8px",
            }}
          >
            {recentWorkspaces.length === 0 ? (
              <Flex
                direction="column"
                align="center"
                justify="center"
                gap="2"
                style={{ height: "100%", minHeight: "160px", textAlign: "center" }}
              >
                {isLoading ? (
                  <>
                    <VibestudioLogo size={44} variant="symbol" />
                    <Spinner size="2" />
                    <Text size="2" color="gray">
                      Loading workspaces...
                    </Text>
                  </>
                ) : (
                  <>
                    <VibestudioLogo size={44} variant="symbol" />
                    <Text size="2" color="gray">
                      {workspaceError ? "Could not load workspaces" : "No workspaces available"}
                    </Text>
                    {workspaceError ? (
                      <Button size="1" variant="soft" onClick={() => void loadRecentWorkspaces()}>
                        Retry
                      </Button>
                    ) : null}
                  </>
                )}
              </Flex>
            ) : (
              <Flex direction="column" gap="2">
                {recentWorkspaces.map((ws) => (
                  <WorkspaceItem
                    key={ws.name}
                    workspace={ws}
                    isActive={ws.name === activeWorkspaceName}
                    onSelect={() => handleChooseWorkspace(ws)}
                    onRemove={(e) => handleRemoveWorkspace(e, ws.name)}
                    canDelete={!remoteWorkspaceMode}
                    canSelect={!remoteWorkspaceMode || ws.name === activeWorkspaceName}
                  />
                ))}
              </Flex>
            )}
          </Box>
        </Flex>
      </Surface>

      {/* Action Buttons */}
      {remoteWorkspaceMode ? (
        <Callout.Root color="blue" mt="4">
          <Callout.Text>
            Workspace creation, deletion, and switching are managed on the remote host. Pair this
            desktop with the target workspace to open it here.
          </Callout.Text>
        </Callout.Root>
      ) : (
        <Flex gap="3" mt="4" justify="center">
          <Button
            variant="soft"
            size="3"
            color="green"
            className="app-touch-target"
            onClick={handleCreateNew}
          >
            <PlusIcon />
            Create New Workspace
          </Button>
        </Flex>
      )}

      {activeWorkspaceName ? <HostTargetsSection /> : null}

      {/* Delete confirmation dialog */}
      <AlertDialog.Root
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialog.Content maxWidth="400px">
          <AlertDialog.Title>Delete workspace</AlertDialog.Title>
          <AlertDialog.Description>
            Permanently delete &ldquo;{pendingDelete}&rdquo;? All panels, packages, agents, and data
            will be removed. This cannot be undone.
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button color="red" onClick={handleConfirmDelete}>
                Delete
              </Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Box>
  );
}

interface WorkspaceItemProps {
  workspace: WorkspaceEntry;
  isActive: boolean;
  onSelect: () => void;
  onRemove: (e: React.MouseEvent) => void;
  canDelete: boolean;
  canSelect: boolean;
}

function WorkspaceItem({
  workspace,
  isActive,
  onSelect,
  onRemove,
  canDelete,
  canSelect,
}: WorkspaceItemProps) {
  return (
    <Card style={{ position: "relative" }} className="workspace-item">
      <Flex justify="between" align="center" p="3" gap="2">
        <button
          type="button"
          onClick={onSelect}
          disabled={!canSelect}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: canSelect ? "pointer" : "default",
            opacity: canSelect ? 1 : 0.65,
          }}
        >
          <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
            <Text size="2" weight="medium" truncate>
              {workspace.name}
              {isActive && (
                <Text size="1" color="gray" ml="2">
                  (current)
                </Text>
              )}
            </Text>
            <Text size="1" color="gray">
              {formatRelativeTime(workspace.lastOpened)}
            </Text>
          </Flex>
        </button>
        {!isActive && canDelete && (
          <IconButton
            variant="ghost"
            size="1"
            color="gray"
            onClick={onRemove}
            aria-label={`Delete workspace ${workspace.name}`}
            title={`Delete workspace ${workspace.name}`}
            style={{ flexShrink: 0 }}
          >
            <TrashIcon />
          </IconButton>
        )}
      </Flex>
    </Card>
  );
}
