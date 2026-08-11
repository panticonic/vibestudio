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
  type TemplateOperation,
  type TemplateStatusRow,
} from "@vibestudio/service-schemas/templates";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { credentials, extensions, rpc } from "@workspace/runtime";
import { createTemplateManagementClient } from "@workspace/template-management";
import {
  TemplateAddButton,
  useTemplateManagementController,
  type TemplateManagementController,
} from "@workspace/template-management/react";
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

const templates = createTemplateManagementClient((extension, method, args) =>
  extensions.invoke(extension, method, args)
);
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
  onCompleted: () => void | Promise<void>;
}) {
  const compare = useCallback<TemplateReviewPanelProps["compare"]>(
    async (item, cursor) => {
      const status = await vcs.status({ contextId: review.contextId });
      return vcs.compare({
        target: status.workingHead,
        source: { kind: "external-delta", deltaId: item.sourceDeltaId },
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
    },
    [review.contextId]
  );
  const merge = useCallback<TemplateReviewPanelProps["merge"]>(
    ({ item, expectedWorkingHead, coordinates, resolutions }) =>
      vcs.merge({
        commandId: commandId(),
        contextId: review.contextId,
        expectedWorkingHead,
        source: { kind: "external-delta", deltaId: item.sourceDeltaId },
        coordinates,
        resolutions,
      }),
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

function TemplateRow({
  row,
  direct,
  controller,
  onDecideSuggestion,
  onResume,
}: {
  row: TemplateStatusRow;
  direct: boolean;
  controller: TemplateManagementController;
  onDecideSuggestion: (
    alias: string,
    section: "trust" | "providers",
    decision: "accept" | "decline"
  ) => Promise<void>;
  onResume: (operationId: string) => Promise<boolean>;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const presentation = templateStatePresentation(row);
  const actions = templateRelationshipActions(direct);
  const run = async (action: string, task: () => Promise<TemplateOperation>) => {
    await controller.execute({
      key: `relationship:${row.alias}`,
      task,
      success: (operation) =>
        operationNotice(
          operation,
          "The operation is approved and ready for review.",
          `The ${row.alias} template ${action} is complete.`
        ),
      failure: () => `Couldn't ${action} the ${row.alias} template. Nothing was changed.`,
    });
  };
  const busy = controller.isBusy(`relationship:${row.alias}`);
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
              {row.contributedParts} {row.contributedParts === 1 ? "contribution" : "contributions"}
            </Text>
          </Flex>
          {/* §7.7 lists a template by version, origin, and parts. The origin
              URL is the identity — there is no publisher identity in this
              system — so leaving it off left the alias, which the workspace
              chose, standing in for where the code actually came from. The
              commit is deliberately absent: no digest appears on any surface a
              person reads (§7.6.3). */}
          <Text as="div" size="1" color="gray" mt="1" style={{ overflowWrap: "anywhere" }}>
            {row.url}
          </Text>
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
                    disabled={controller.isBusy(`suggestion:${row.alias}:${suggestion.section}`)}
                    onClick={() => void onDecideSuggestion(row.alias, suggestion.section, "accept")}
                  >
                    Accept
                  </Button>
                  <Button
                    size="1"
                    variant="soft"
                    disabled={controller.isBusy(`suggestion:${row.alias}:${suggestion.section}`)}
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
              disabled={busy}
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
              {busy ? "Connecting…" : "Connect account"}
            </Button>
          ) : null}
          {actions.check ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy || controller.loading}
              onClick={() => void controller.refresh()}
            >
              <ReloadIcon /> Check for updates
            </Button>
          ) : null}
          {row.review?.items.length ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy || !row.review.approvalGranted}
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
              disabled={busy}
              onClick={() =>
                void run("update", () =>
                  templates.pull({ commandId: commandId(), alias: row.alias })
                )
              }
            >
              {busy ? "Asking…" : "Update"}
            </Button>
          ) : null}
          {actions.remove ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy}
              onClick={() =>
                void run("remove", () =>
                  templates.remove({ commandId: commandId(), alias: row.alias })
                )
              }
            >
              {busy ? "Asking…" : "Remove"}
            </Button>
          ) : null}
          {actions.suggest ? (
            <Button
              size="1"
              variant="ghost"
              disabled={busy}
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
          onCompleted={async () => {
            if (await onResume(row.review!.operationId)) setReviewOpen(false);
          }}
        />
      ) : null}
    </Card>
  );
}

function TemplatesPage() {
  const controller = useTemplateManagementController(templates);
  const { rows, operations, catalog, loading, notice, error } = controller;
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");

  useEffect(() => {
    void controller.refresh();
  }, [controller.refresh]);

  const visibleCatalog = useMemo(
    () => filterTemplateCatalog(catalog?.entries ?? [], query),
    [catalog, query]
  );

  const resume = async (operationId: string): Promise<boolean> => {
    const result = await controller.execute({
      key: `operation:${operationId}`,
      task: () => templates.resume({ operationId }),
      success: (operation) =>
        operationNotice(
          operation,
          "The template operation is ready to continue.",
          "The template operation is complete."
        ),
      failure: () => "Couldn't resume this template operation. Nothing was changed.",
    });
    return result !== null;
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
          commandId: commandId(),
          alias,
          section,
          decision,
        }),
      success: () =>
        `${section === "trust" ? "Trust" : "Provider"} suggestion ${decision === "accept" ? "accepted" : "declined"}.`,
      failure: () => "Couldn't record this template suggestion decision. Nothing was changed.",
    });
  };

  const cancel = async (operationId: string) => {
    await controller.execute({
      key: `operation:${operationId}`,
      task: () => templates.cancel({ operationId }),
      success: () => "Template operation cancelled. Its unpublished context was discarded.",
      failure: () => "Couldn't cancel this template operation. Nothing was changed.",
    });
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
          {error ? (
            <Callout.Root color="red">
              <Callout.Text>{error}</Callout.Text>
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
                              disabled={controller.isBusy(`operation:${operation.operationId}`)}
                              onClick={() => void resume(operation.operationId)}
                            >
                              Resume
                            </Button>
                          ) : null}
                          <Button
                            size="1"
                            variant="soft"
                            color="red"
                            disabled={controller.isBusy(`operation:${operation.operationId}`)}
                            onClick={() => void cancel(operation.operationId)}
                          >
                            Cancel
                          </Button>
                        </Flex>
                      </Flex>
                      {operation.review ? (
                        <AboutTemplateReview
                          review={operation.review}
                          onCompleted={async () => {
                            await resume(operation.operationId);
                          }}
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
                  controller={controller}
                  onDecideSuggestion={decideSuggestion}
                  onResume={resume}
                />
              ))}
            </Flex>
          </Section>
          <Separator size="4" />
          <Section title="Browse templates">
            <Flex align="center" justify="between" gap="2" wrap="wrap">
              <Text size="1" color={catalog?.stale ? "orange" : "gray"}>
                {catalog
                  ? `Registry ${catalog.revision}${catalog.stale ? " · cached" : ""}`
                  : "No verified registry is cached"}
              </Text>
              <Button
                size="1"
                variant="soft"
                disabled={loading}
                onClick={() => void controller.refresh({ refreshCatalog: true })}
              >
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
                    <TemplateAddButton
                      client={templates}
                      request={{ catalogId: entry.id }}
                      triggerLabel="Add"
                      disabled={controller.anyBusy}
                      onCompleted={async (operation) => {
                        await controller.complete(
                          operation,
                          operationNotice(
                            operation,
                            `The ${entry.name} template is ready for review.`,
                            `The ${entry.name} template is connected.`
                          )
                        );
                      }}
                    />
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
                  <TemplateAddButton
                    client={templates}
                    request={{
                      url: url.trim(),
                      ...(credential.trim() ? { credential: credential.trim() } : {}),
                    }}
                    triggerLabel="Add address"
                    disabled={controller.anyBusy || !isTemplateHttpUrl(url)}
                    onCompleted={async (operation) => {
                      const outcome = operationNotice(
                        operation,
                        "The selected template is ready for review.",
                        "The selected template is connected."
                      );
                      await controller.complete(operation, outcome);
                      setUrl("");
                      setCredential("");
                    }}
                  />
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
