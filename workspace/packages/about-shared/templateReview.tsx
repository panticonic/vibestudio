import { Badge, Box, Button, Card, Flex, Spinner, Text } from "@radix-ui/themes";
import { useCallback, useEffect, useState } from "react";
import type { TemplateReviewHandle } from "@vibestudio/service-schemas/templates";
import type { VcsCompareResult, VcsIntegrationChoice } from "@vibestudio/service-schemas/vcs";

export interface TemplateReviewSession {
  contextId: string;
  items: readonly TemplateReviewHandle[];
}

export interface TemplateReviewPanelProps {
  review: TemplateReviewSession;
  compare(item: TemplateReviewHandle): Promise<VcsCompareResult>;
  integrate(input: {
    item: TemplateReviewHandle;
    expectedWorkingHead: VcsCompareResult["target"];
    decision: VcsIntegrationChoice;
  }): Promise<unknown>;
  onCompleted?(): Promise<void> | void;
}

type ComparisonEntry = {
  item: TemplateReviewHandle;
  comparison: VcsCompareResult;
};

/**
 * The template coordinator owns only lifecycle/finalization. Incoming changes
 * are deliberately reviewed through the ordinary VCS compare/integrate
 * protocol, so this surface never creates a template-specific decision path.
 */
export function TemplateReviewPanel({ review, compare, integrate, onCompleted }: TemplateReviewPanelProps) {
  const [comparisons, setComparisons] = useState<ComparisonEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await Promise.all(
        review.items.map(async (item) => ({ item, comparison: await compare(item) }))
      );
      setComparisons(next);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't load these incoming changes.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [compare, review.items]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = async (
    entry: ComparisonEntry,
    changeId: string,
    kind: "adopted" | "declined"
  ) => {
    setActing(changeId);
    setError(null);
    try {
      const decision: VcsIntegrationChoice =
        kind === "adopted"
          ? { kind, sourceChangeIds: [changeId] }
          : {
              kind,
              sourceChangeIds: [changeId],
              rationale: "Kept the workspace version during template review.",
            };
      await integrate({
        item: entry.item,
        expectedWorkingHead: entry.comparison.target,
        decision,
      });
      const next = await refresh();
      if (next?.every((candidate) => candidate.comparison.resolution.complete)) {
        await onCompleted?.();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't record that review decision.");
    } finally {
      setActing(null);
    }
  };

  return (
    <Card size="1" mt="2" aria-label="Incoming template changes">
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="2" wrap="wrap">
          <Box>
            <Text as="div" size="2" weight="medium">Review incoming changes</Text>
            <Text as="div" size="1" color="gray">Choose how each change should affect this workspace.</Text>
          </Box>
          <Button size="1" variant="soft" disabled={loading || acting !== null} onClick={() => void refresh()}>
            {loading ? <Spinner /> : "Refresh review"}
          </Button>
        </Flex>
        {error ? <Text role="alert" size="1" color="red">{error}</Text> : null}
        {comparisons?.map((entry) => (
          <Flex key={entry.item.deltaId} direction="column" gap="2">
            <Text size="1" weight="medium">{entry.item.repoPath}</Text>
            {entry.comparison.changes.map((change) => {
              const disposition = change.disposition;
              const applicability =
                disposition.status === "actionable" ? disposition.applicability : null;
              const actionable = applicability !== null;
              const applicable = applicability === "applicable";
              const conflicting = applicability === "conflicting";
              const blocked = applicability === "blocked";
              return (
                <Card key={change.changeId} size="1">
                  <Flex direction="column" gap="2">
                    <Text size="2">{change.summary}</Text>
                    <Flex align="center" gap="2" wrap="wrap">
                      <Badge size="1" color={actionable ? "orange" : "gray"} variant="soft">
                        {applicability ?? disposition.status}
                      </Badge>
                      {applicable ? (
                        <Button size="1" disabled={acting !== null} onClick={() => void decide(entry, change.changeId, "adopted")}>
                          {acting === change.changeId ? "Applying…" : "Use this change"}
                        </Button>
                      ) : null}
                      {actionable && !blocked ? (
                        <Button size="1" variant="soft" disabled={acting !== null} onClick={() => void decide(entry, change.changeId, "declined")}>
                          Keep workspace version
                        </Button>
                      ) : null}
                    </Flex>
                    {conflicting ? <Text size="1" color="gray">This needs a merge before it can be used. Keep the workspace version, or resolve the merge through the VCS workflow and refresh.</Text> : null}
                    {blocked ? <Text size="1" color="gray">Resolve its earlier incoming changes first, then refresh this review.</Text> : null}
                  </Flex>
                </Card>
              );
            })}
            {entry.comparison.changes.length === 0 ? <Text size="1" color="gray">No effective changes remain for this part.</Text> : null}
          </Flex>
        ))}
        {comparisons?.every((entry) => entry.comparison.resolution.complete) ? <Text size="1" color="green">All incoming changes have been accounted for. The template update can now finish.</Text> : null}
      </Flex>
    </Card>
  );
}
