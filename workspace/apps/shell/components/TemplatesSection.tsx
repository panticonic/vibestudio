import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Card, Flex, Spinner, Text, TextField } from "@radix-ui/themes";
import type {
  TemplateInspection,
  TemplateOperation,
  TemplateStatusRow,
} from "@vibestudio/service-schemas/templates";
import type { TemplateCatalogSnapshot } from "@workspace/template-registry";
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
  pending: string
): string {
  if (operation.state !== "pending" && operation.state !== "applied") {
    return (
      operation.blocker?.message ??
      "This template operation needs your attention before it can continue."
    );
  }
  return pending;
}

function version(ref: string): string {
  return ref.split("/").filter(Boolean).at(-1) || ref;
}

function WorkspaceTemplateReview({
  review,
  onCompleted,
}: {
  review: NonNullable<TemplateOperation["review"]>;
  onCompleted: () => void;
}) {
  const compare = useCallback(
    (item: NonNullable<TemplateOperation["review"]>["items"][number]) =>
      vcs.compareDelta(review.contextId, item.deltaId),
    [review.contextId]
  );
  const integrate = useCallback<TemplateReviewPanelProps["integrate"]>(
    ({ item, expectedWorkingHead, decision }) =>
      vcs.integrateDelta(review.contextId, expectedWorkingHead, item.deltaId, decision),
    [review.contextId]
  );
  return (
    <TemplateReviewPanel
      review={review}
      compare={compare}
      integrate={integrate}
      onCompleted={onCompleted}
    />
  );
}

/**
 * The workspace-settings surface for direct template relationships. Inherited
 * rows deliberately remain visible, but cannot be removed independently.
 */
export function TemplatesSection() {
  const [rows, setRows] = useState<TemplateStatusRow[]>([]);
  const [operations, setOperations] = useState<Awaited<ReturnType<typeof templates.operations>>>(
    []
  );
  const [catalog, setCatalog] = useState<TemplateCatalogSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewingAlias, setReviewingAlias] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<{
    locator: { catalogId: string; registryRevision: string } | { url: string; credential?: string };
    name: string;
    inspection: TemplateInspection;
    choices: Record<string, "keep" | "take" | "skip">;
  } | null>(null);

  const refresh = useCallback(async (refreshCatalog = false) => {
    setBusy("loading");
    try {
      const [nextRows, nextOperations] = await Promise.all([
        templates.status(),
        templates.operations(),
      ]);
      setOperations(nextOperations);
      let catalogFailed = false;
      try {
        setCatalog(await templates.catalog(refreshCatalog ? { refresh: true } : undefined));
      } catch (failure) {
        catalogFailed = true;
        setCatalog(null);
        setError(`The verified template registry is unavailable. ${message(failure)}`);
      }
      let candidates: Awaited<ReturnType<typeof templates.check>> = [];
      let displayedRows = nextRows;
      try {
        candidates = await templates.check();
        // Successful explicit acquisition re-anchors this host session. The
        // follow-up status read is local-only and exposes that verified state.
        displayedRows = await templates.status();
      } catch {
        // Update discovery is optional network work. Keep copied relationships
        // visible and marked available offline.
      }
      const updates = new Set(candidates.map((candidate) => candidate.alias));
      setRows(
        displayedRows.map((row) =>
          updates.has(row.alias) && row.state === "current"
            ? { ...row, state: "update-available" as const }
            : row
        )
      );
      if (!refreshCatalog && !catalogFailed) setError(null);
    } catch (failure) {
      setError(`Couldn't load templates. ${message(failure)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const visibleCatalog = useMemo(() => {
    return filterTemplateCatalog(catalog?.entries ?? [], query);
  }, [catalog, query]);

  const add = async (
    locator: { catalogId: string; registryRevision: string } | { url: string; credential?: string }
  ) => {
    setBusy("add");
    setError(null);
    setNotice(null);
    try {
      // Resolve first so a URL failure, private-template prompt, or version
      // disagreement is visible before approval is requested.
      const inspection = await templates.inspect(locator);
      const name =
        "catalogId" in locator
          ? (catalog?.entries.find((entry) => entry.id === locator.catalogId)?.name ?? "selected")
          : "selected";
      if (inspection.conflicts.length > 0) {
        setAddDraft({ locator, name, inspection, choices: {} });
        return;
      }
      const operation = await templates.add({
        commandId: crypto.randomUUID(),
        pin: inspection.pin,
      });
      setNotice(
        operationMessage(
          operation,
          "The approved template operation is ready for any required VCS review."
        )
      );
      if ("url" in locator) {
        setUrl("");
        setCredential("");
      }
    } catch (failure) {
      setError(`Couldn't add this template. ${message(failure)}`);
    } finally {
      setBusy(null);
    }
  };

  const addUrl = () => {
    if (!isTemplateHttpUrl(url)) {
      setError("Enter a full HTTP(S) template address.");
      return;
    }
    void add({
      url: url.trim(),
      ...(credential.trim() ? { credential: credential.trim() } : {}),
    });
  };

  const confirmAdd = async () => {
    if (!addDraft) return;
    setBusy("add");
    try {
      const operation = await templates.add({
        commandId: crypto.randomUUID(),
        pin: addDraft.inspection.pin,
        choices: addDraft.choices,
      });
      setAddDraft(null);
      setNotice(
        operationMessage(
          operation,
          "The approved template operation is ready for any required VCS review."
        )
      );
    } catch (failure) {
      setError(`Couldn't add this template. ${message(failure)}`);
    } finally {
      setBusy(null);
    }
  };

  const update = async (alias: string) => {
    setBusy(`update:${alias}`);
    setError(null);
    try {
      await templates.check({ alias });
      const operation = await templates.pull({ commandId: crypto.randomUUID(), alias });
      setNotice(
        operationMessage(
          operation,
          `The approved ${alias} update is ready for any required VCS review.`
        )
      );
    } catch (failure) {
      setError(`Couldn't check ${alias}. ${message(failure)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (alias: string) => {
    setBusy(`remove:${alias}`);
    setError(null);
    try {
      const operation = await templates.remove({ commandId: crypto.randomUUID(), alias });
      setNotice(
        operationMessage(
          operation,
          `Ready for your review. Removing ${alias} keeps its parts in your workspace.`
        )
      );
    } catch (failure) {
      setError(`Couldn't remove ${alias}. ${message(failure)}`);
    } finally {
      setBusy(null);
    }
  };

  const resume = async (operationId: string) => {
    setBusy(`resume:${operationId}`);
    setError(null);
    try {
      const operation = await templates.resume({
        operationId,
        onBuildFailure: "discard-context",
      });
      setNotice(operationMessage(operation, "The template operation is ready to continue."));
      await refresh();
    } catch (failure) {
      setError(`Couldn't resume this template operation. ${message(failure)}`);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (operationId: string) => {
    setBusy(`cancel:${operationId}`);
    setError(null);
    try {
      await templates.cancel({ operationId });
      setNotice("The template operation was discarded.");
      await refresh();
    } catch (failure) {
      setError(`Couldn't discard this template operation. ${message(failure)}`);
    } finally {
      setBusy(null);
    }
  };

  const decideSuggestion = async (
    alias: string,
    section: "trust" | "providers",
    decision: "accept" | "decline"
  ) => {
    setBusy(`suggestion:${alias}:${section}`);
    setError(null);
    try {
      await templates.decideSuggestion({
        commandId: crypto.randomUUID(),
        alias,
        section,
        decision,
      });
      setNotice(
        `${section === "trust" ? "Trust" : "Provider"} suggestion ${decision === "accept" ? "accepted" : "declined"}.`
      );
      await refresh();
    } catch (failure) {
      setError(`Couldn't record this template suggestion decision. ${message(failure)}`);
    } finally {
      setBusy(null);
    }
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
            disabled={busy !== null}
            onClick={() => void refresh(true)}
          >
            {busy === "loading" ? <Spinner /> : "Refresh"}
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
                      disabled={busy !== null}
                      onClick={() => void resume(operation.operationId)}
                    >
                      Resume
                    </Button>
                  ) : null}
                  <Button
                    size="1"
                    variant="soft"
                    color="red"
                    disabled={busy !== null}
                    onClick={() => void cancel(operation.operationId)}
                  >
                    Discard
                  </Button>
                </Flex>
              </Flex>
              {operation.review ? (
                <WorkspaceTemplateReview
                  review={operation.review}
                  onCompleted={() => void resume(operation.operationId)}
                />
              ) : null}
            </Flex>
          </Card>
        ))}
        {rows.map((row) => {
          const direct = row.direct;
          return (
            <Card key={row.nodeId} size="1" style={{ marginLeft: direct ? 0 : 16 }}>
              <Flex align="center" justify="between" gap="2" wrap="wrap">
                <Box>
                  <Text as="div" size="2" weight="medium">
                    {direct ? row.alias : `Comes with: ${row.alias}`} template
                  </Text>
                  <Text as="div" size="1" color="gray">
                    {version(row.ref)} · {row.ownedParts} {row.ownedParts === 1 ? "part" : "parts"}
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
                            disabled={busy !== null}
                            onClick={() =>
                              void decideSuggestion(row.alias, suggestion.section, "accept")
                            }
                          >
                            Accept
                          </Button>
                          <Button
                            size="1"
                            variant="soft"
                            disabled={busy !== null}
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
                      disabled={busy !== null || !row.review.approvalGranted}
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
                      disabled={busy !== null}
                      onClick={() =>
                        void (async () => {
                          setBusy(`credential:${row.alias}`);
                          setError(null);
                          try {
                            await credentials.requestCredentialInput(
                              gitCredentialInputRequest(row.blocker!.credential!)
                            );
                            await update(row.alias);
                          } catch (failure) {
                            setError(`Couldn't connect this account. ${message(failure)}`);
                          } finally {
                            setBusy(null);
                          }
                        })()
                      }
                    >
                      {busy === `credential:${row.alias}` ? "Connecting…" : "Connect account"}
                    </Button>
                  ) : null}
                  {direct && !row.review?.items.length ? (
                    <Button
                      size="1"
                      variant="soft"
                      disabled={busy !== null}
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
                      disabled={busy !== null}
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
                  onCompleted={() => {
                    setReviewingAlias(null);
                    void refresh();
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
              <Button
                size="1"
                disabled={busy !== null}
                onClick={() =>
                  void add({ catalogId: entry.id, registryRevision: catalog!.revision })
                }
              >
                Add
              </Button>
            </Flex>
          ))}
          {visibleCatalog.length === 0 &&
          templateCatalogEmptyMessage(catalog?.entries.length ?? 0, query) ? (
            <Text size="2" color="gray">
              {templateCatalogEmptyMessage(catalog?.entries.length ?? 0, query)}
            </Text>
          ) : null}
        </Flex>
        {addDraft ? (
          <Card size="1">
            <Flex direction="column" gap="2">
              <Text size="2" weight="medium">
                Choose what to do with conflicts from {addDraft.name}.
              </Text>
              {addDraft.inspection.conflicts.map((conflict) => (
                <Box key={conflict.repoPath}>
                  <Text as="div" size="1">
                    {conflict.repoPath} is included by {conflict.claimants.join(" and ")}.
                  </Text>
                  <Flex gap="1" mt="1" wrap="wrap">
                    {(["keep", "take", "skip"] as const).map((choice) => (
                      <Button
                        key={choice}
                        size="1"
                        variant={addDraft.choices[conflict.repoPath] === choice ? "solid" : "soft"}
                        onClick={() =>
                          setAddDraft({
                            ...addDraft,
                            choices: { ...addDraft.choices, [conflict.repoPath]: choice },
                          })
                        }
                      >
                        {choice === "keep"
                          ? "Keep yours"
                          : choice === "take"
                            ? "Take template"
                            : "Skip"}
                      </Button>
                    ))}
                  </Flex>
                </Box>
              ))}
              <Flex gap="2">
                <Button
                  size="1"
                  disabled={
                    addDraft.inspection.conflicts.some(
                      (conflict) => !addDraft.choices[conflict.repoPath]
                    ) || busy !== null
                  }
                  onClick={() => void confirmAdd()}
                >
                  Add template
                </Button>
                <Button size="1" variant="soft" onClick={() => setAddDraft(null)}>
                  Not now
                </Button>
              </Flex>
            </Flex>
          </Card>
        ) : null}
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
          <Button size="1" disabled={busy !== null || !url.trim()} onClick={addUrl}>
            Add address
          </Button>
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
