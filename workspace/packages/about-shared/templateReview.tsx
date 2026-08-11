import { Badge, Box, Button, Card, Flex, Spinner, Text } from "@radix-ui/themes";
import { useCallback, useEffect, useState } from "react";
import type { TemplateReviewHandle } from "@vibestudio/service-schemas/templates";
import type { VcsCompareResult, VcsMergeResolutionKind } from "@vibestudio/service-schemas/vcs";

export interface TemplateReviewSession {
  contextId: string;
  items: readonly TemplateReviewHandle[];
}

export interface TemplateReviewPanelProps {
  review: TemplateReviewSession;
  compare(item: TemplateReviewHandle, cursor?: string): Promise<VcsCompareResult>;
  merge(input: {
    item: TemplateReviewHandle;
    expectedWorkingHead: VcsCompareResult["target"];
    coordinates: Array<{ kind: "file" | "repository"; id: string }>;
    resolutions: Array<{
      coordinate: { kind: "file" | "repository"; id: string };
      resolution: VcsMergeResolutionKind;
    }>;
  }): Promise<unknown>;
  onCompleted?(): Promise<void> | void;
}

type ComparisonEntry = {
  item: TemplateReviewHandle;
  comparison: Omit<VcsCompareResult, "coordinates" | "nextCursor"> & {
    coordinates: VcsCompareResult["coordinates"];
    nextCursor: null;
  };
};

/**
 * The template coordinator owns only lifecycle/finalization. Incoming changes
 * are deliberately reviewed through the ordinary VCS compare/merge
 * protocol, so this surface never creates a template-specific decision path.
 */
export function TemplateReviewPanel({
  review,
  compare,
  merge,
  onCompleted,
}: TemplateReviewPanelProps) {
  const [comparisons, setComparisons] = useState<ComparisonEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await Promise.all(
        review.items.map(async (item) => {
          let page = await compare(item);
          const coordinates = [...page.coordinates];
          while (page.nextCursor) {
            page = await compare(item, page.nextCursor);
            coordinates.push(...page.coordinates);
          }
          return {
            item,
            comparison: { ...page, coordinates, nextCursor: null },
          };
        })
      );
      setComparisons(next);
      return next;
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Couldn't load these incoming changes."
      );
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
    selected: VcsCompareResult["coordinates"][number],
    resolution: "composed" | "theirs" | "ours"
  ) => {
    const coordinate = {
      kind: selected.coordinate.kind,
      id: selected.coordinate.id,
    };
    const key = `${coordinate.kind}:${coordinate.id}`;
    const members = selected.group
      ? entry.comparison.coordinates.filter(
          (candidate) => candidate.group === selected.group && candidate.status !== "resolved"
        )
      : [selected];
    setActing(key);
    setError(null);
    try {
      await merge({
        item: entry.item,
        expectedWorkingHead: entry.comparison.target,
        coordinates: members.map((member) => ({
          kind: member.coordinate.kind,
          id: member.coordinate.id,
        })),
        resolutions: members.map((member) => ({
          coordinate: { kind: member.coordinate.kind, id: member.coordinate.id },
          resolution:
            resolution === "composed"
              ? member.status === "composed"
                ? "composed"
                : "theirs"
              : resolution,
        })),
      });
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Couldn't record that review decision."
      );
    } finally {
      setActing(null);
    }
  };

  const finish = async () => {
    setActing("finish");
    setError(null);
    try {
      await onCompleted?.();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Couldn't finish this template operation."
      );
    } finally {
      setActing(null);
    }
  };

  const complete =
    comparisons !== null &&
    comparisons.length > 0 &&
    comparisons.every(
      (entry) => entry.comparison.resolution.complete && entry.comparison.resolution.concluded
    );

  return (
    <Card size="1" mt="2" aria-label="Incoming template changes">
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="2" wrap="wrap">
          <Box>
            <Text as="div" size="2" weight="medium">
              Review incoming changes
            </Text>
            <Text as="div" size="1" color="gray">
              Choose how each change should affect this workspace.
            </Text>
          </Box>
          <Button
            size="1"
            variant="soft"
            disabled={loading || acting !== null}
            onClick={() => void refresh()}
          >
            {loading ? <Spinner /> : "Refresh review"}
          </Button>
        </Flex>
        {error ? (
          <Text role="alert" size="1" color="red">
            {error}
          </Text>
        ) : null}
        {comparisons?.map((entry) => (
          <Flex key={entry.item.sourceDeltaId} direction="column" gap="2">
            <Text size="1" weight="medium">
              {entry.item.repoPath}
            </Text>
            {entry.comparison.coordinates.map((coordinate) => {
              const key = `${coordinate.coordinate.kind}:${coordinate.coordinate.id}`;
              const unresolved =
                coordinate.status !== "resolved" && coordinate.status !== "convergent";
              const conflicting = coordinate.status === "conflict";
              return (
                <Card key={key} size="1">
                  <Flex direction="column" gap="2">
                    <Text size="2">{coordinate.summary}</Text>
                    <Flex align="center" gap="2" wrap="wrap">
                      <Badge size="1" color={unresolved ? "orange" : "gray"} variant="soft">
                        {coordinate.status}
                      </Badge>
                      {unresolved && !conflicting ? (
                        <Button
                          size="1"
                          disabled={acting !== null}
                          onClick={() =>
                            void decide(
                              entry,
                              coordinate,
                              coordinate.status === "composed" ? "composed" : "theirs"
                            )
                          }
                        >
                          {acting === key
                            ? "Applying…"
                            : coordinate.status === "composed"
                              ? "Use combined result"
                              : "Use source result"}
                        </Button>
                      ) : null}
                      {unresolved ? (
                        <Button
                          size="1"
                          variant="soft"
                          disabled={acting !== null}
                          onClick={() => void decide(entry, coordinate, "ours")}
                        >
                          Keep workspace version
                        </Button>
                      ) : null}
                    </Flex>
                    {conflicting ? (
                      <Text size="1" color="gray">
                        This needs a merge before it can be used. Keep the workspace version, or
                        resolve the merge through the VCS workflow and refresh.
                      </Text>
                    ) : null}
                  </Flex>
                </Card>
              );
            })}
            {entry.comparison.coordinates.length === 0 ? (
              <Text size="1" color="gray">
                No effective changes remain for this part.
              </Text>
            ) : null}
          </Flex>
        ))}
        {complete ? (
          <Flex align="center" justify="between" gap="2" wrap="wrap">
            <Text size="1" color="green">
              All incoming changes have been accounted for. The template operation is ready to
              finish.
            </Text>
            <Button disabled={acting !== null} onClick={() => void finish()}>
              {acting === "finish" ? "Finishing…" : "Finish template operation"}
            </Button>
          </Flex>
        ) : null}
      </Flex>
    </Card>
  );
}
