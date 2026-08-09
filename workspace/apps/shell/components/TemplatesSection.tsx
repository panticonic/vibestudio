import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Card, Flex, Spinner, Text, TextField } from "@radix-ui/themes";
import type { TemplateOperation, TemplateStatusRow } from "@vibestudio/service-schemas/templates";
import {
  TemplateAddDialog,
  useTemplateManagementController,
} from "@workspace/template-management/react";
import {
  filterTemplateCatalog,
  gitCredentialInputRequest,
  isTemplateHttpUrl,
  templateCatalogEmptyMessage,
} from "@workspace/about-shared/templates";
import {
  TemplateReviewPanel,
  type TemplateReviewPanelProps,
} from "@workspace/about-shared/template-review";
import { credentials, templates, vcs } from "../shell/client";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateLabel(row: TemplateStatusRow): string {
  if (row.verification === "deferred") return "Available offline";
  switch (row.state) {
    case "current":
      return "Up to date";
    case "update-available":
      return "Update available";
    case "reviewing":
      return `Reviewing changes${row.pendingReviews ? ` — ${row.pendingReviews} to review` : ""}`;
    case "waiting-for-credential":
      return "Connect an account to finish";
    case "local-changes":
      return "Local changes";
    case "conflict":
      return "Needs a choice";
    default:
      return "Needs attention";
  }
}

function operationMessage(
  operation: Awaited<ReturnType<typeof templates.add>>,
  copy: { applied: string; pending: string }
): string {
  if (operation.state === "applied") return copy.applied;
  if (operation.state !== "pending") {
    return (
      operation.blocker?.message ??
      "This template operation needs your attention before it can continue."
    );
  }
  return copy.pending;
}

function version(ref: string): string {
  return ref.split("/").filter(Boolean).at(-1) || ref;
}

function WorkspaceTemplateReview({
  review,
  onCompleted,
}: {
  review: NonNullable<TemplateOperation["review"]>;
  onCompleted: () => void | Promise<void>;
}) {
  const compare = useCallback(
    (item: NonNullable<TemplateOperation["review"]>["items"][number], cursor?: string) =>
      vcs.compareDelta(review.contextId, item.deltaId, cursor),
    [review.contextId]
  );
  const merge = useCallback<TemplateReviewPanelProps["merge"]>(
    ({ item, expectedWorkingHead, coordinates, resolutions }) =>
      vcs.mergeDelta(
        review.contextId,
        expectedWorkingHead,
        item.deltaId,
        coordinates,
        resolutions
      ),
    [review.contextId]
  );
  return (
    <TemplateReviewPanel
      review={review}
      compare={compare}
      merge={merge}
      onCompleted={onCompleted}
    />
  );
}

/**
 * The workspace-settings surface for direct template relationships. Inherited
 * rows deliberately remain visible, but cannot be removed independently.
 */
export function TemplatesSection() {
  const controller = useTemplateManagementController(templates);
  const { rows, operations, catalog, loading, notice, error } = controller;
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [reviewingAlias, setReviewingAlias] = useState<string | null>(null);

  useEffect(() => {
    void controller.refresh();
  }, [controller.refresh]);

  const visibleCatalog = useMemo(() => {
    return filterTemplateCatalog(catalog?.entries ?? [], query);
  }, [catalog, query]);

  const update = async (alias: string) => {
    await controller.execute({
      key: `relationship:${alias}`,
      task: async () => {
        await templates.check({ alias });
        return templates.pull({ commandId: crypto.randomUUID(), alias });
      },
      success: (operation) =>
        operationMessage(operation, {
          applied: `The ${alias} template is up to date.`,
          pending: `Review the incoming changes to finish updating ${alias}.`,
        }),
      failure: (failure) => `Couldn't update ${alias}. Nothing was changed. ${message(failure)}`,
    });
  };

  const remove = async (alias: string) => {
    await controller.execute({
      key: `relationship:${alias}`,
      task: () => templates.remove({ commandId: crypto.randomUUID(), alias }),
      success: (operation) =>
        operationMessage(operation, {
          applied: `Removed the ${alias} template. Its parts are now part of your workspace.`,
          pending: `Review the changes to remove ${alias}. Its parts will stay in your workspace.`,
        }),
      failure: (failure) => `Couldn't remove ${alias}. Nothing was changed. ${message(failure)}`,
    });
  };

  const resume = async (operationId: string): Promise<boolean> => {
    const result = await controller.execute({
      key: `operation:${operationId}`,
      task: () => templates.resume({ operationId, onBuildFailure: "discard-context" }),
      success: (operation) =>
        operationMessage(operation, {
          applied: "The template change is complete.",
          pending: "Review the incoming changes to finish.",
        }),
      failure: (failure) =>
        `Couldn't resume this template operation. Nothing was changed. ${message(failure)}`,
    });
    return result !== null;
  };

  const cancel = async (operationId: string) => {
    await controller.execute({
      key: `operation:${operationId}`,
      task: () => templates.cancel({ operationId }),
      success: () => "The template operation was discarded.",
      failure: (failure) => `Couldn't discard this template operation. ${message(failure)}`,
    });
  };

  const decideSuggestion = async (
    alias: string,
    section: "trust" | "providers",
    decision: "accept" | "decline"
  ) => {
    await controller.execute({
      key: `suggestion:${alias}:${section}`,
      task: () =>
        templates.decideSuggestion({
          commandId: crypto.randomUUID(),
          alias,
          section,
          decision,
        }),
      success: () =>
        `${section === "trust" ? "Trust" : "Provider"} suggestion ${decision === "accept" ? "accepted" : "declined"}.`,
      failure: (failure) =>
        `Couldn't record this template suggestion decision. ${message(failure)}`,
    });
  };

  return (
    <Card mt="4" aria-label="Templates">
      <Flex direction="column" gap="3">
        <Flex align="center" justify="between" gap="2" wrap="wrap">
          <Box>
            <Text as="div" weight="bold">
              Templates
            </Text>
            <Text as="div" size="1" color="gray">
              Templates shape this workspace. You review changes before anything is added.
            </Text>
          </Box>
          <Button
            size="1"
            variant="soft"
            disabled={loading}
            onClick={() => void controller.refresh({ refreshCatalog: true })}
          >
            {loading ? <Spinner /> : "Refresh"}
          </Button>
        </Flex>
        {operations.map((operation) => (
          <Card key={operation.operationId} size="1">
            <Flex direction="column" gap="2">
              <Flex justify="between" align="center" gap="2">
                <Box>
                  <Text as="div" size="2" weight="medium">
                    {operation.kind} template operation
                  </Text>
                  <Text as="div" size="1" color="gray">
                    {operation.operationId}
                  </Text>
                </Box>
                <Flex gap="1">
                  {!operation.review ? (
                    <Button
                      size="1"
                      variant="soft"
                      disabled={controller.isBusy(`operation:${operation.operationId}`)}
                      onClick={() => void resume(operation.operationId)}
                    >
                      {operation.repair ? "Rebuild" : "Resume"}
                    </Button>
                  ) : null}
                  <Button
                    size="1"
                    variant="soft"
                    color="red"
                    disabled={controller.isBusy(`operation:${operation.operationId}`)}
                    onClick={() => void cancel(operation.operationId)}
                  >
                    Discard
                  </Button>
                </Flex>
              </Flex>
              {operation.review ? (
                <WorkspaceTemplateReview
                  review={operation.review}
                  onCompleted={async () => {
                    await resume(operation.operationId);
                  }}
                />
              ) : null}
              {operation.repair ? (
                <Box>
                  <Text as="div" size="2" color="orange">
                    The merged result is retained for repair.
                  </Text>
                  {operation.repair.failures.map((failure) => (
                    <Text key={`${failure.unit}:${failure.message}`} as="div" size="1" color="gray">
                      {failure.unit}: {failure.message}
                    </Text>
                  ))}
                </Box>
              ) : null}
            </Flex>
          </Card>
        ))}
        {rows.map((row) => {
          const direct = row.direct;
          const relationshipBusy = controller.isBusy(`relationship:${row.alias}`);
          return (
            <Card key={row.nodeId} size="1" style={{ marginLeft: direct ? 0 : 16 }}>
              <Flex align="center" justify="between" gap="2" wrap="wrap">
                <Box>
                  <Text as="div" size="2" weight="medium">
                    {direct ? row.alias : `Comes with: ${row.alias}`} template
                  </Text>
                  <Text as="div" size="1" color="gray">
                    {version(row.ref)} · {row.contributedParts}{" "}
                    {row.contributedParts === 1 ? "contribution" : "contributions"}
                  </Text>
                  {row.error ? (
                    <Text as="div" size="1" color="red">
                      {row.error}
                    </Text>
                  ) : null}
                  {row.blocker ? (
                    <Text as="div" size="1" color="orange">
                      {row.blocker.message}
                    </Text>
                  ) : null}
                  {row.review?.items.length ? (
                    <Text as="div" size="1" color="blue">
                      {row.review.approvalGranted
                        ? `Review changes in ${row.review.items.map((item) => item.repoPath).join(", ")} through VCS.`
                        : "Await approval before reviewing these changes."}
                    </Text>
                  ) : null}
                  {row.suggestions.map((suggestion) => (
                    <Card key={suggestion.section} size="1" mt="2">
                      <Flex direction="column" gap="1">
                        <Text size="1">
                          Suggested {suggestion.section}: {JSON.stringify(suggestion.value)}
                        </Text>
                        <Flex gap="1">
                          <Button
                            size="1"
                            disabled={controller.isBusy(
                              `suggestion:${row.alias}:${suggestion.section}`
                            )}
                            onClick={() =>
                              void decideSuggestion(row.alias, suggestion.section, "accept")
                            }
                          >
                            Accept
                          </Button>
                          <Button
                            size="1"
                            variant="soft"
                            disabled={controller.isBusy(
                              `suggestion:${row.alias}:${suggestion.section}`
                            )}
                            onClick={() =>
                              void decideSuggestion(row.alias, suggestion.section, "decline")
                            }
                          >
                            Decline
                          </Button>
                        </Flex>
                      </Flex>
                    </Card>
                  ))}
                </Box>
                <Flex align="center" gap="2" wrap="wrap">
                  <Badge
                    color={row.state === "error" || row.state === "conflict" ? "red" : "gray"}
                    variant="soft"
                  >
                    {stateLabel(row)}
                  </Badge>
                  {row.review?.items.length ? (
                    <Button
                      size="1"
                      variant="soft"
                      disabled={relationshipBusy || !row.review.approvalGranted}
                      onClick={() =>
                        setReviewingAlias((current) => (current === row.alias ? null : row.alias))
                      }
                    >
                      {row.review.approvalGranted
                        ? reviewingAlias === row.alias
                          ? "Close review"
                          : "Continue review"
                        : "Await approval"}
                    </Button>
                  ) : null}
                  {row.blocker?.nextAction === "connect-credential" && row.blocker.credential ? (
                    <Button
                      size="1"
                      disabled={relationshipBusy}
                      onClick={() =>
                        void controller.execute({
                          key: `relationship:${row.alias}`,
                          task: async () => {
                            await credentials.requestCredentialInput(
                              gitCredentialInputRequest(row.blocker!.credential!)
                            );
                            await templates.check({ alias: row.alias });
                            return templates.pull({
                              commandId: crypto.randomUUID(),
                              alias: row.alias,
                            });
                          },
                          success: (operation) =>
                            operationMessage(operation, {
                              applied: `The ${row.alias} template is up to date.`,
                              pending: `Review the incoming changes to finish updating ${row.alias}.`,
                            }),
                          failure: (failure) =>
                            `Couldn't connect this account. ${message(failure)}`,
                        })
                      }
                    >
                      {relationshipBusy ? "Connecting…" : "Connect account"}
                    </Button>
                  ) : null}
                  {direct && !row.review?.items.length ? (
                    <Button
                      size="1"
                      variant="soft"
                      disabled={relationshipBusy}
                      onClick={() => void update(row.alias)}
                    >
                      {row.state === "update-available" ? "Update" : "Check for updates"}
                    </Button>
                  ) : null}
                  {direct ? (
                    <Button
                      size="1"
                      color="gray"
                      variant="soft"
                      disabled={relationshipBusy}
                      onClick={() => void remove(row.alias)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </Flex>
              </Flex>
              {row.review && row.review.approvalGranted && reviewingAlias === row.alias ? (
                <WorkspaceTemplateReview
                  review={row.review}
                  onCompleted={async () => {
                    if (await resume(row.review!.operationId)) setReviewingAlias(null);
                  }}
                />
              ) : null}
            </Card>
          );
        })}
        {rows.length === 0 ? (
          <Text size="2" color="gray">
            No committed template relationships yet.
          </Text>
        ) : null}
        <Text size="1" color={catalog?.stale ? "orange" : "gray"}>
          {catalog
            ? `Registry ${catalog.revision}${catalog.stale ? " · cached" : ""}`
            : "No verified registry is cached"}
        </Text>
        <TextField.Root
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search templates"
          aria-label="Search templates"
        />
        <Flex direction="column" gap="2">
          {visibleCatalog.map((entry) => (
            <Flex key={entry.id} align="center" justify="between" gap="2">
              <Box>
                <Text as="div" size="2" weight="medium">
                  {entry.name}
                </Text>
                <Text as="div" size="1" color="gray">
                  {entry.description}
                </Text>
              </Box>
              <TemplateAddDialog
                client={templates}
                request={{ catalogId: entry.id }}
                triggerLabel="Add"
                disabled={controller.anyBusy}
                onCompleted={async (operation) => {
                  await controller.complete(
                    operation,
                    operationMessage(operation, {
                      applied: `Added the ${entry.name} template.`,
                      pending: `Review the incoming changes to finish adding the ${entry.name} template.`,
                    })
                  );
                }}
              />
            </Flex>
          ))}
          {visibleCatalog.length === 0 &&
          templateCatalogEmptyMessage(catalog?.entries.length ?? 0, query) ? (
            <Text size="2" color="gray">
              {templateCatalogEmptyMessage(catalog?.entries.length ?? 0, query)}
            </Text>
          ) : null}
        </Flex>
        <Flex gap="2" wrap="wrap">
          <TextField.Root
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            placeholder="Logical credential name (optional)"
            aria-label="Template logical credential name"
            style={{ flex: "1 1 190px" }}
          />
          <TextField.Root
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Paste a template address"
            aria-label="Template address"
            style={{ flex: "1 1 220px" }}
          />
          <TemplateAddDialog
            client={templates}
            request={{
              url: url.trim(),
              ...(credential.trim() ? { credential: credential.trim() } : {}),
            }}
            triggerLabel="Add address"
            disabled={controller.anyBusy || !isTemplateHttpUrl(url)}
            onCompleted={async (operation) => {
              const outcome = operationMessage(operation, {
                applied: "Added the selected template.",
                pending: "Review the incoming changes to finish adding the selected template.",
              });
              await controller.complete(operation, outcome);
              setUrl("");
              setCredential("");
            }}
          />
        </Flex>
        {notice ? (
          <Text role="status" size="1" color="green">
            {notice}
          </Text>
        ) : null}
        {error ? (
          <Text role="alert" size="1" color="red">
            {error}
          </Text>
        ) : null}
      </Flex>
    </Card>
  );
}
