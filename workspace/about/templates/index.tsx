import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Separator,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import { ReloadIcon } from "@radix-ui/react-icons";
import {
  type TemplateExactPin,
  type TemplateOperation,
  type TemplateInspection,
  type TemplateStatusRow,
} from "@vibestudio/service-schemas/templates";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { credentials, extensions, rpc } from "@workspace/runtime";
import type { TemplateCatalogSnapshot } from "@workspace/template-registry";
import { AboutPage, AboutThemeRoot, Section } from "../../packages/about-shared/ui";
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
import {
  templateRelationshipActions,
  templateStatePresentation,
  templateVersion,
} from "./presentation";

const TEMPLATE_COMPOSER = "@workspace-extensions/template-composer";
type TemplateLocator =
  | { catalogId: string; registryRevision: string }
  | { url: string; credential?: string };

function templateComposerCall<T>(method: string, args: unknown[] = []): Promise<T> {
  return extensions.invoke(TEMPLATE_COMPOSER, method, args) as Promise<T>;
}

const templates = {
  status: () => templateComposerCall<TemplateStatusRow[]>("status"),
  catalog: (options?: { refresh?: boolean }) =>
    templateComposerCall<TemplateCatalogSnapshot>("catalog", options ? [options] : []),
  check: () =>
    templateComposerCall<
      Array<{
        alias: string;
      }>
    >("check"),
  inspect: (locator: TemplateLocator) =>
    templateComposerCall<TemplateInspection>("inspect", [locator]),
  add: (input: {
    commandId: string;
    pin: TemplateExactPin;
    choices?: Record<string, "keep" | "take" | "skip">;
  }) => templateComposerCall<TemplateOperation>("add", [input]),
  pull: (input: { commandId: string; alias: string }) =>
    templateComposerCall<TemplateOperation>("pull", [input]),
  remove: (input: { commandId: string; alias: string }) =>
    templateComposerCall<TemplateOperation>("remove", [input]),
  suggest: (input: { commandId: string; alias: string }) =>
    templateComposerCall<TemplateOperation>("suggest", [input]),
  operations: () =>
    templateComposerCall<
      Array<{
        operationId: string;
        kind: "add" | "pull" | "remove" | "recompose" | "adopt-bootstrap";
        contextId: string;
        state: "pending" | "reviewing";
        fingerprint: string;
        review?: NonNullable<TemplateOperation["review"]>;
      }>
    >("operations"),
  resume: (input: { operationId: string }) =>
    templateComposerCall<TemplateOperation>("resume", [input]),
  cancel: (input: { operationId: string }) =>
    templateComposerCall<{ operationId: string; state: "cancelled" }>("cancel", [input]),
  decideSuggestion: (input: {
    commandId: string;
    alias: string;
    section: "trust" | "providers";
    decision: "accept" | "decline";
  }) =>
    templateComposerCall<{
      operationId: string;
      state: "accepted" | "declined";
      section: "trust" | "providers";
    }>("decideSuggestion", [input]),
};
const vcs = createTypedServiceClient("vcs", vcsMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
function commandId(): string {
  return `templates-panel:${crypto.randomUUID()}`;
}

function operationNotice(
  operation: TemplateOperation,
  pendingMessage: string,
  appliedMessage: string
): string {
  if (operation.state !== "pending" && operation.state !== "applied") {
    return (
      operation.blocker?.message ??
      "This template operation needs your attention before it can continue."
    );
  }
  if (operation.state === "applied") {
    if (!operation.contribution) return appliedMessage;
    return operation.contribution.url
      ? `Your suggestion is ready on ${operation.contribution.branch}. Open it: ${operation.contribution.url}`
      : `Your suggestion is ready on ${operation.contribution.branch}.`;
  }
  return pendingMessage;
}

function AboutTemplateReview({
  review,
  onCompleted,
}: {
  review: NonNullable<TemplateStatusRow["review"]>;
  onCompleted: () => void;
}) {
  const compare = useCallback<TemplateReviewPanelProps["compare"]>(
    async (item) => {
      const status = await vcs.status({ contextId: review.contextId });
      return vcs.compare({
        target: status.workingHead,
        sourceDeltaId: item.deltaId,
        view: "changes",
        limit: 200,
      });
    },
    [review.contextId]
  );
  const integrate = useCallback<TemplateReviewPanelProps["integrate"]>(
    ({ item, expectedWorkingHead, decision }) =>
      vcs.integrate({
        commandId: commandId(),
        contextId: review.contextId,
        expectedWorkingHead,
        sourceDeltaId: item.deltaId,
        decision,
      }),
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

function TemplateRow({
  row,
  direct,
  onRefresh,
  onNotice,
  onDecideSuggestion,
}: {
  row: TemplateStatusRow;
  direct: boolean;
  onRefresh: () => Promise<void>;
  onNotice: (text: string) => void;
  onDecideSuggestion: (
    alias: string,
    section: "trust" | "providers",
    decision: "accept" | "decline"
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const presentation = templateStatePresentation(row);
  const actions = templateRelationshipActions(direct);
  const run = async (action: string, task: () => Promise<TemplateOperation>) => {
    setBusy(action);
    try {
      const operation = await task();
      onNotice(
        operationNotice(
          operation,
          "The operation is approved and ready for review.",
          `The ${row.alias} template ${action} is complete.`
        )
      );
      await onRefresh();
    } catch {
      onNotice(`Couldn't ${action} the ${row.alias} template. Nothing was changed.`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card size="2">
      <Flex align="start" justify="between" gap="3" wrap="wrap">
        <Box style={{ minWidth: 0, flex: "1 1 240px" }}>
          <Text as="div" size="3" weight="medium">
            {row.alias} template · {templateVersion(row.ref)}
          </Text>
          <Flex gap="2" mt="1" align="center" wrap="wrap">
            <Badge color={presentation.color} variant="soft">
              {presentation.label}
            </Badge>
            <Text size="1" color="gray">
              {row.ownedParts} {row.ownedParts === 1 ? "part" : "parts"}
            </Text>
          </Flex>
          {row.error ? (
            <Text as="div" size="1" color="red" mt="2">
              {row.error}
            </Text>
          ) : null}
          {row.blocker ? (
            <Text as="div" size="1" color="orange" mt="2">
              {row.blocker.message}
            </Text>
          ) : null}
          {row.review?.items.length ? (
            <Text as="div" size="1" color="blue" mt="2">
              {row.review.approvalGranted
                ? `Review changes in ${row.review.items.map((item) => item.repoPath).join(", ")} through the normal VCS review flow.`
                : "Review preparation is still in progress."}
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
                    onClick={() => void onDecideSuggestion(row.alias, suggestion.section, "accept")}
                  >
                    Accept
                  </Button>
                  <Button
                    size="1"
                    variant="soft"
                    disabled={busy !== null}
                    onClick={() =>
                      void onDecideSuggestion(row.alias, suggestion.section, "decline")
                    }
                  >
                    Decline
                  </Button>
                </Flex>
              </Flex>
            </Card>
          ))}
        </Box>
        <Flex gap="2" wrap="wrap">
          {row.blocker?.nextAction === "connect-credential" && row.blocker.credential ? (
            <Button
              size="1"
              disabled={busy !== null}
              onClick={() =>
                void run("connect", async () => {
                  await credentials.requestCredentialInput(
                    gitCredentialInputRequest(row.blocker!.credential!)
                  );
                  return templates.pull({
                    commandId: commandId(),
                    alias: row.alias,
                  });
                })
              }
            >
              {busy === "connect" ? "Connecting…" : "Connect account"}
            </Button>
          ) : null}
          {actions.check ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy !== null}
              onClick={() => void onRefresh()}
            >
              <ReloadIcon /> Check for updates
            </Button>
          ) : null}
          {row.review?.items.length ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy !== null || !row.review.approvalGranted}
              onClick={() => setReviewOpen((open) => !open)}
            >
              {row.review.approvalGranted
                ? reviewOpen
                  ? "Close review"
                  : "Continue review"
                : "Preparing review"}
            </Button>
          ) : null}
          {actions.update && !row.review?.items.length ? (
            <Button
              size="1"
              disabled={busy !== null}
              onClick={() =>
                void run("update", () =>
                  templates.pull({ commandId: commandId(), alias: row.alias })
                )
              }
            >
              {busy === "update" ? "Asking…" : "Update"}
            </Button>
          ) : null}
          {actions.remove ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy !== null}
              onClick={() =>
                void run("remove", () =>
                  templates.remove({ commandId: commandId(), alias: row.alias })
                )
              }
            >
              {busy === "remove" ? "Asking…" : "Remove"}
            </Button>
          ) : null}
          {actions.suggest ? (
            <Button
              size="1"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run("suggest changes to", () =>
                  templates.suggest({ commandId: commandId(), alias: row.alias })
                )
              }
            >
              Suggest changes
            </Button>
          ) : null}
        </Flex>
      </Flex>
      {reviewOpen && row.review?.approvalGranted ? (
        <AboutTemplateReview
          review={row.review}
          onCompleted={() => {
            setReviewOpen(false);
            void onRefresh();
          }}
        />
      ) : null}
    </Card>
  );
}

function TemplatesPage() {
  const [rows, setRows] = useState<TemplateStatusRow[]>([]);
  const [operations, setOperations] = useState<Awaited<ReturnType<typeof templates.operations>>>(
    []
  );
  const [catalog, setCatalog] = useState<TemplateCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [addDraft, setAddDraft] = useState<{
    locator: TemplateLocator;
    name: string;
    inspection: TemplateInspection;
    choices: Record<string, "keep" | "take" | "skip">;
  } | null>(null);

  const refresh = useCallback(async (refreshCatalog = false) => {
    setLoading(true);
    try {
      const [status, pendingOperations] = await Promise.all([
        templates.status(),
        templates.operations(),
      ]);
      setOperations(pendingOperations);
      let catalogFailed = false;
      try {
        setCatalog(await templates.catalog(refreshCatalog ? { refresh: true } : undefined));
      } catch {
        catalogFailed = true;
        setCatalog(null);
        setNotice(
          "The verified template registry is unavailable. Connected templates remain usable."
        );
      }
      let updates: Awaited<ReturnType<typeof templates.check>> = [];
      try {
        updates = await templates.check();
      } catch {
        // Update discovery is passive. A transient remote failure must not
        // hide the exact locally tracked relationships.
      }
      const updateAliases = new Set(updates.map((candidate) => candidate.alias));
      setRows(
        status.map((row) =>
          row.state === "current" && updateAliases.has(row.alias)
            ? { ...row, state: "update-available" as const }
            : row
        )
      );
      if (!refreshCatalog && !catalogFailed) setNotice(null);
    } catch {
      setNotice("Couldn't load templates. Nothing was changed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const visibleCatalog = useMemo(
    () => filterTemplateCatalog(catalog?.entries ?? [], query),
    [catalog, query]
  );

  const prepareAdd = async (locator: TemplateLocator, name: string) => {
    try {
      const inspection = await templates.inspect(locator);
      if (inspection.conflicts.length > 0) {
        setAddDraft({ locator, name, inspection, choices: {} });
        return;
      }
      await add(locator, name, {}, inspection.pin);
    } catch {
      setNotice(`Couldn't inspect the ${name} template. Nothing was changed.`);
    }
  };

  const add = async (
    locator: TemplateLocator,
    name: string,
    choices: Record<string, "keep" | "take" | "skip">,
    pin: TemplateExactPin
  ) => {
    try {
      const operation = await templates.add({
        commandId: commandId(),
        pin,
        ...(Object.keys(choices).length ? { choices } : {}),
      });
      setNotice(
        operationNotice(
          operation,
          `The ${name} template is approved and ready for review.`,
          `The ${name} template is already connected.`
        )
      );
      await refresh();
      setAddDraft(null);
      if ("url" in locator) {
        setUrl("");
        setCredential("");
      }
    } catch {
      setNotice(`Couldn't add the ${name} template. Nothing was changed.`);
    }
  };

  const addUrl = () => {
    if (!isTemplateHttpUrl(url)) {
      setNotice("Enter a full HTTP(S) template address.");
      return;
    }
    void prepareAdd(
      {
        url: url.trim(),
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      },
      "selected"
    );
  };

  const resume = async (operationId: string) => {
    try {
      const operation = await templates.resume({ operationId });
      setNotice(
        operationNotice(
          operation,
          "The template operation is ready to continue.",
          "The template operation is complete."
        )
      );
      await refresh();
    } catch {
      setNotice("Couldn't resume this template operation. Nothing was changed.");
    }
  };

  const decideSuggestion = async (
    alias: string,
    section: "trust" | "providers",
    decision: "accept" | "decline"
  ) => {
    try {
      await templates.decideSuggestion({
        commandId: commandId(),
        alias,
        section,
        decision,
      });
      setNotice(
        `${section === "trust" ? "Trust" : "Provider"} suggestion ${decision === "accept" ? "accepted" : "declined"}.`
      );
      await refresh();
    } catch {
      setNotice("Couldn't record this template suggestion decision. Nothing was changed.");
    }
  };

  const cancel = async (operationId: string) => {
    try {
      await templates.cancel({ operationId });
      setNotice("Template operation cancelled. Its unpublished context was discarded.");
      await refresh();
    } catch {
      setNotice("Couldn't cancel this template operation. Nothing was changed.");
    }
  };

  return (
    <AboutThemeRoot>
      <AboutPage
        title="Templates"
        subtitle="Choose, update, and share the building blocks of your workspace."
      >
        <Flex direction="column" gap="4">
          {notice ? (
            <Callout.Root color="blue">
              <Callout.Text>{notice}</Callout.Text>
            </Callout.Root>
          ) : null}
          {operations.length > 0 ? (
            <Section title="Pending template operations">
              <Flex direction="column" gap="2">
                {operations.map((operation) => (
                  <Card key={operation.operationId} size="2">
                    <Flex direction="column" gap="2">
                      <Flex align="center" justify="between" gap="2" wrap="wrap">
                        <Box>
                          <Text as="div" weight="medium">
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
                              onClick={() => void resume(operation.operationId)}
                            >
                              Resume
                            </Button>
                          ) : null}
                          <Button
                            size="1"
                            variant="soft"
                            color="red"
                            onClick={() => void cancel(operation.operationId)}
                          >
                            Cancel
                          </Button>
                        </Flex>
                      </Flex>
                      {operation.review ? (
                        <AboutTemplateReview
                          review={operation.review}
                          onCompleted={() => void resume(operation.operationId)}
                        />
                      ) : null}
                    </Flex>
                  </Card>
                ))}
              </Flex>
            </Section>
          ) : null}
          <Section title="Connected templates">
            <Flex direction="column" gap="2">
              {loading ? (
                <Flex align="center" gap="2">
                  <Spinner />
                  <Text>Checking templates…</Text>
                </Flex>
              ) : null}
              {!loading && rows.length === 0 ? (
                <Text color="gray">
                  No committed template relationships yet. Add one from the catalog below.
                </Text>
              ) : null}
              {rows.map((row) => (
                <TemplateRow
                  key={row.nodeId}
                  row={row}
                  direct={row.direct}
                  onRefresh={refresh}
                  onNotice={setNotice}
                  onDecideSuggestion={decideSuggestion}
                />
              ))}
            </Flex>
          </Section>
          <Separator size="4" />
          <Section title="Browse templates">
            {addDraft ? (
              <Callout.Root color="orange">
                <Callout.Text>
                  <Flex direction="column" gap="2">
                    <Text weight="medium">
                      Choose what to do with overlapping parts from the {addDraft.name} template.
                    </Text>
                    {addDraft.inspection.conflicts.map((conflict) => (
                      <Box key={conflict.repoPath}>
                        <Text as="div" size="2">
                          {conflict.repoPath} is included by {conflict.claimants.join(" and ")}.
                        </Text>
                        <Flex gap="2" mt="1" wrap="wrap">
                          {(["keep", "take", "skip"] as const).map((choice) => (
                            <Button
                              key={choice}
                              size="1"
                              variant={
                                addDraft.choices[conflict.repoPath] === choice ? "solid" : "soft"
                              }
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
                        disabled={addDraft.inspection.conflicts.some(
                          (conflict) => !addDraft.choices[conflict.repoPath]
                        )}
                        onClick={() =>
                          void add(
                            addDraft.locator,
                            addDraft.name,
                            addDraft.choices,
                            addDraft.inspection.pin
                          )
                        }
                      >
                        Add template
                      </Button>
                      <Button size="1" variant="soft" onClick={() => setAddDraft(null)}>
                        Not now
                      </Button>
                    </Flex>
                  </Flex>
                </Callout.Text>
              </Callout.Root>
            ) : null}
            <Flex align="center" justify="between" gap="2" wrap="wrap">
              <Text size="1" color={catalog?.stale ? "orange" : "gray"}>
                {catalog
                  ? `Registry ${catalog.revision}${catalog.stale ? " · cached" : ""}`
                  : "No verified registry is cached"}
              </Text>
              <Button size="1" variant="soft" disabled={loading} onClick={() => void refresh(true)}>
                <ReloadIcon /> Refresh catalog
              </Button>
            </Flex>
            <TextField.Root
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search templates"
              aria-label="Search templates"
            />
            <Flex direction="column" gap="2">
              {visibleCatalog.map((entry) => (
                <Card key={entry.id} size="1">
                  <Flex align="center" justify="between" gap="3" wrap="wrap">
                    <Box style={{ minWidth: 0, flex: "1 1 220px" }}>
                      <Text as="div" weight="medium">
                        {entry.name} template
                      </Text>
                      <Text as="div" size="1" color="gray">
                        {entry.description}
                      </Text>
                    </Box>
                    <Button
                      size="1"
                      onClick={() =>
                        void prepareAdd(
                          { catalogId: entry.id, registryRevision: catalog!.revision },
                          entry.name
                        )
                      }
                    >
                      Add
                    </Button>
                  </Flex>
                </Card>
              ))}
              {visibleCatalog.length === 0 &&
              templateCatalogEmptyMessage(catalog?.entries.length ?? 0, query) ? (
                <Text size="2" color="gray">
                  {templateCatalogEmptyMessage(catalog?.entries.length ?? 0, query)}
                </Text>
              ) : null}
            </Flex>
            <Card size="1">
              <Flex direction="column" gap="2">
                <TextField.Root
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="Paste a template address"
                  aria-label="Template address"
                />
                <Flex gap="2" wrap="wrap">
                  <TextField.Root
                    value={credential}
                    onChange={(event) => setCredential(event.target.value)}
                    placeholder="Logical credential (optional)"
                    aria-label="Logical Git credential"
                    style={{ flex: "1 1 220px" }}
                  />
                  <Button size="1" disabled={!url.trim()} onClick={addUrl}>
                    Add address
                  </Button>
                </Flex>
              </Flex>
            </Card>
          </Section>
        </Flex>
      </AboutPage>
    </AboutThemeRoot>
  );
}

export default TemplatesPage;
