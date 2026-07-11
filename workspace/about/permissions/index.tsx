import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Callout, Card, Flex, Heading, Spinner, Text } from "@radix-ui/themes";
import {
  ExclamationTriangleIcon,
  LockClosedIcon,
  ReloadIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { panel, rpc } from "../../packages/runtime/src/panel/index";
import { AboutPage, AboutThemeRoot, Section } from "../../packages/about-shared/ui";

export interface SavedPermissionGrant {
  id: string;
  kind: "capability" | "userland";
  callerLabel: string;
  scopeLabel: string;
  capability?: string;
  resource?: string;
  repoPath?: string;
  effectiveVersion?: string;
  grantedAt?: number;
}

function dateLabel(value?: number): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)
    : "Date unavailable";
}

function GrantCard({
  grant,
  revoking,
  onRevoke,
}: {
  grant: SavedPermissionGrant;
  revoking: boolean;
  onRevoke(): void;
}) {
  return (
    <Card size="2">
      <Flex justify="between" align="start" gap="3" wrap="wrap">
        <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
          <Flex align="center" gap="2" wrap="wrap">
            <Heading size="3">{grant.callerLabel}</Heading>
            <Badge color={grant.kind === "capability" ? "blue" : "purple"} variant="soft">
              {grant.kind === "capability" ? "System capability" : "Agent choice"}
            </Badge>
          </Flex>
          <Text size="2">{grant.scopeLabel}</Text>
          {grant.capability || grant.resource ? (
            <Text size="2" color="gray">
              {[grant.capability, grant.resource].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
          {grant.repoPath ? (
            <Text size="1" color="gray">
              {grant.repoPath}
              {grant.effectiveVersion ? ` · version ${grant.effectiveVersion}` : ""}
            </Text>
          ) : null}
          <Text size="1" color="gray">
            Granted {dateLabel(grant.grantedAt)}
          </Text>
        </Flex>
        <Button color="red" variant="soft" disabled={revoking} onClick={onRevoke}>
          {revoking ? <Spinner size="1" /> : <TrashIcon />} {revoking ? "Revoking…" : "Revoke"}
        </Button>
      </Flex>
    </Card>
  );
}

function PermissionsPage() {
  const [grants, setGrants] = useState<SavedPermissionGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGrants(await rpc.call<SavedPermissionGrant[]>("main", "permissions.list", []));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return panel.onFocus(() => void load());
  }, [load]);

  const revoke = useCallback(async (grant: SavedPermissionGrant) => {
    setRevokingId(grant.id);
    setError(null);
    try {
      await rpc.call("main", "permissions.revoke", [{ kind: grant.kind, id: grant.id }]);
      setGrants((current) => current.filter((item) => item.id !== grant.id));
    } catch (err) {
      setError(
        `Couldn't revoke the permission: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setRevokingId(null);
    }
  }, []);

  return (
    <AboutPage
      icon={<LockClosedIcon width={20} height={20} />}
      title="Permissions"
      subtitle="Lasting access you granted to apps and agents"
      maxWidth={820}
      actions={
        <Button size="2" variant="soft" onClick={() => void load()} disabled={loading}>
          <ReloadIcon /> Refresh
        </Button>
      }
    >
      <Section>
        <Text size="2" color="gray">
          “Allow once” decisions do not appear here. Revoking a saved permission makes the app or
          agent ask again the next time it needs that access.
        </Text>
      </Section>
      {error ? (
        <Callout.Root color="red" role="alert">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            <Flex direction="column" gap="2">
              <Text>{error}</Text>
              <Button size="1" color="red" variant="soft" onClick={() => void load()}>
                Retry
              </Button>
            </Flex>
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {loading && grants.length === 0 ? (
        <Flex justify="center" align="center" gap="2" py="6">
          <Spinner />
          <Text color="gray">Loading saved permissions…</Text>
        </Flex>
      ) : null}
      {!loading && !error && grants.length === 0 ? (
        <Section>
          <Heading size="3" mb="1">
            No saved permissions
          </Heading>
          <Text size="2" color="gray">
            Apps and agents currently have no lasting capability or choice grants. One-time
            approvals are intentionally not retained.
          </Text>
        </Section>
      ) : null}
      <Flex direction="column" gap="3">
        {grants.map((grant) => (
          <GrantCard
            key={`${grant.kind}:${grant.id}`}
            grant={grant}
            revoking={revokingId === grant.id}
            onRevoke={() => void revoke(grant)}
          />
        ))}
      </Flex>
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <PermissionsPage />
    </AboutThemeRoot>
  );
}
