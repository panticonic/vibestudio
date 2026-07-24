import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  SegmentedControl,
  Spinner,
  Text,
} from "@radix-ui/themes";
import {
  ExclamationTriangleIcon,
  LockClosedIcon,
  ReloadIcon,
  ResetIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { panel, rpc } from "../../packages/runtime/src/panel/index";
import { AboutPage, AboutThemeRoot, Section } from "../../packages/about-shared/ui";

export interface SavedPermissionGrant {
  id: string;
  kind: "capability" | "userland" | "credential-use" | "browser-site";
  callerLabel: string;
  scopeLabel: string;
  capability?: string;
  resource?: string;
  repoPath?: string;
  effectiveVersion?: string;
  grantedAt?: number;
  lastUsedAt?: number;
  expiresAt?: number;
  why: string;
  approvedBy: string;
  duration: string;
  revokeEffect: string;
}

type DomainId =
  | "files"
  | "sharing"
  | "accounts"
  | "web"
  | "automation"
  | "people"
  | "computer"
  | "safety";
type Verb = "see" | "act" | "manage";
type ProfileItem = {
  id: string;
  kind: "grant" | "lock";
  capability?: string;
  action: string;
  resource?: string;
  domain: DomainId;
  verb: Verb;
  state: "active" | "suspended" | "locked";
  decidedAt: number;
  lastUsedAt?: number;
  attemptCount?: number;
  lastAttemptAt?: number;
  why: string;
  approvedBy: string;
  duration: string;
  revokeEffect: string;
};
type AgentAuthorityProfile = {
  bindingId: string;
  name: string;
  summary: string;
  paused: boolean;
  cells: Array<{
    domain: DomainId;
    verb: Verb;
    state: "asks-first" | "allowed" | "never" | "not-available";
    allowanceCount: number;
    items: ProfileItem[];
  }>;
};
type AuthoritySafetyStatus = {
  workspaceLocked: boolean;
  activeAgentCount: number;
  pendingAcquisitionCount: number;
};
type MissionRecord = {
  missionId: string;
  name: string;
  revision: number;
  state: "draft" | "active" | "needs-reapproval" | "paused" | "retired";
  closureDigest: string;
  updatedAt: number;
  charter: {
    taskSpec: string;
    trigger:
      | { kind: "manual" }
      | { kind: "cron"; cron: string }
      | { kind: "event"; event: { source: string } };
    toolExposure: {
      services: string[];
      evalNetwork: "none" | "declared-origins" | "unrestricted";
      declaredOrigins: string[];
    };
    declaredLineageClasses: string[];
  };
  permissions: unknown[];
};
type MissionRunRecord = {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: string;
};
type WorkspaceUnitStatus = {
  name: string;
  kind: "panel" | "worker" | "extension" | "app";
  isAgent?: boolean;
  source: string;
  displayName?: string;
  status: "running" | "stopped" | "error" | "pending-approval" | "building" | "available";
  version?: string;
  ev?: string | null;
  activeEv?: string | null;
  pendingApproval?: { kind: string; submittedAt: number } | null;
  lastError?: string | null;
  authorityRows?: AuthorityRow[];
};
type AuthorityRow = {
  capability: string;
  domain: DomainId;
  verb: Verb;
  action: string;
  resource: string;
  tier: "gated" | "critical";
  statement: "declared" | "allowed" | "snapshot" | "prospective";
};
type GovernanceDecision = {
  approvalId: string;
  approvalKind: string;
  decision: string;
  granted: boolean;
  resolvedAt: number;
  resolvedBy: { handle: string };
  requestedBy: { callerId: string };
  resource?: { capability?: string; value?: string; key?: string };
  grantScopeStored?: string | null;
};

const DOMAIN_COPY: Record<DomainId, string> = {
  files: "Your files & work",
  sharing: "Publishing & sending",
  accounts: "Accounts & sign-ins",
  web: "The web",
  automation: "Apps & automation",
  people: "People & devices",
  computer: "This computer",
  safety: "Safety controls",
};
const VERB_COPY: Record<Verb, string> = { see: "See", act: "Do", manage: "Manage" };

function ProfileCard({
  profile,
  changingId,
  onChange,
}: {
  profile: AgentAuthorityProfile;
  changingId: string | null;
  onChange(request: Record<string, unknown>): void;
}) {
  const byDomain = useMemo(
    () =>
      (Object.keys(DOMAIN_COPY) as DomainId[]).map((domain) => ({
        domain,
        cells: profile.cells.filter((cell) => cell.domain === domain),
      })),
    [profile]
  );
  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <div>
          <Flex align="center" gap="2" wrap="wrap">
            <Heading size="4">{profile.name}</Heading>
            {profile.paused ? <Badge color="red">Paused</Badge> : null}
          </Flex>
          <Text size="2" color="gray">
            {profile.summary}
          </Text>
        </div>
        <Flex direction="column" gap="2">
          {byDomain.map(({ domain, cells }) => (
            <Card key={domain} variant="surface">
              <Flex direction="column" gap="2">
                <Heading size="2">{DOMAIN_COPY[domain]}</Heading>
                <Flex gap="2" wrap="wrap">
                  {cells.map((cell) => (
                    <Badge
                      key={cell.verb}
                      color={
                        cell.state === "allowed"
                          ? "green"
                          : cell.state === "never" || cell.state === "not-available"
                            ? "red"
                            : "gray"
                      }
                      variant={cell.state === "asks-first" ? "outline" : "soft"}
                    >
                      {VERB_COPY[cell.verb]} ·{" "}
                      {cell.state === "allowed"
                        ? `Allowed: ${cell.allowanceCount}`
                        : cell.state === "asks-first"
                          ? "Asks first"
                          : cell.state === "never"
                            ? "Never"
                            : "Not available"}
                    </Badge>
                  ))}
                </Flex>
                {cells
                  .flatMap((cell) => cell.items)
                  .map((item) => (
                    <Flex key={`${item.kind}:${item.id}`} justify="between" align="center" gap="3">
                      <Text size="2">
                        {item.action}
                        {item.resource ? ` — ${item.resource}` : ""}
                        {item.state === "suspended" ? " · paused after 3 months without use" : ""}
                        {item.kind === "lock" && item.attemptCount
                          ? ` · ${item.attemptCount} attempts while locked`
                          : ""}
                      </Text>
                      <details>
                        <summary>Why this setting exists</summary>
                        <Text as="div" size="1" color="gray">
                          {item.why} Approved by {item.approvedBy}. {item.duration}. If changed:{" "}
                          {item.revokeEffect}
                        </Text>
                      </details>
                      <Button
                        size="1"
                        variant="soft"
                        disabled={changingId === item.id}
                        onClick={() =>
                          onChange({
                            action:
                              item.kind === "lock"
                                ? "unlock"
                                : item.state === "suspended"
                                  ? "restore-grant"
                                  : "revoke-grant",
                            id: item.id,
                          })
                        }
                      >
                        {item.kind === "lock"
                          ? "Unlock"
                          : item.state === "suspended"
                            ? "Restore"
                            : "Remove"}
                      </Button>
                    </Flex>
                  ))}
              </Flex>
            </Card>
          ))}
        </Flex>
        <Flex gap="2" wrap="wrap">
          <Button
            variant="soft"
            disabled={changingId === profile.bindingId}
            onClick={() =>
              onChange({
                action: profile.paused ? "resume-agent" : "pause-agent",
                bindingId: profile.bindingId,
              })
            }
          >
            {profile.paused ? "Resume agent" : "Pause agent now"}
          </Button>
          <Button
            color="red"
            variant="soft"
            disabled={changingId === profile.bindingId}
            onClick={() => onChange({ action: "revoke-all-agent", bindingId: profile.bindingId })}
          >
            <ResetIcon /> Revoke all authority
          </Button>
        </Flex>
        <Text size="1" color="gray">
          Pausing stops active work and blocks new protected actions. Revoking removes access you
          granted to this agent; its installed code still cannot exceed the abilities you reviewed.
        </Text>
      </Flex>
    </Card>
  );
}

function DomainPivot({
  domain,
  profiles,
  units,
  changingId,
  onChange,
}: {
  domain: DomainId;
  profiles: AgentAuthorityProfile[];
  units: WorkspaceUnitStatus[];
  changingId: string | null;
  onChange(request: Record<string, unknown>): void;
}) {
  const visible = profiles
    .map((profile) => ({
      profile,
      cells: profile.cells.filter(
        (cell) =>
          cell.domain === domain &&
          (cell.state !== "asks-first" || cell.items.length > 0 || domain === "safety")
      ),
    }))
    .filter(({ cells }) => cells.length > 0);
  return (
    <Flex direction="column" gap="3">
      <Card size="3">
        <Heading size="4">{DOMAIN_COPY[domain]}</Heading>
        <Text as="p" size="2" color="gray">
          See every agent with a saved setting here. “Asks first” means no lasting access is stored;
          “Never” stops the request without prompting.
        </Text>
      </Card>
      {visible.length === 0 ? (
        <Card size="2">
          <Heading size="3">Everyone asks first</Heading>
          <Text size="2" color="gray">
            No agent has a lasting permission or “never” choice in this area.
          </Text>
        </Card>
      ) : (
        visible.map(({ profile, cells }) => (
          <Card key={profile.bindingId} size="2">
            <Flex direction="column" gap="3">
              <Flex justify="between" align="start" gap="3" wrap="wrap">
                <div>
                  <Heading size="3">{profile.name}</Heading>
                  <Text size="2" color="gray">
                    {cells
                      .map(
                        (cell) =>
                          `${VERB_COPY[cell.verb]}: ${
                            cell.state === "allowed"
                              ? `Allowed (${cell.allowanceCount})`
                              : cell.state === "never"
                                ? "Never"
                                : cell.state === "not-available"
                                  ? "Not available"
                                  : "Asks first"
                          }`
                      )
                      .join(" · ")}
                  </Text>
                </div>
              </Flex>
              {cells
                .flatMap((cell) => cell.items)
                .map((item) => (
                  <Flex key={`${item.kind}:${item.id}`} justify="between" align="center" gap="3">
                    <Text size="2">
                      {item.action}
                      {item.resource ? ` — ${item.resource}` : ""}
                      {item.kind === "lock" && item.attemptCount
                        ? ` · ${item.attemptCount} attempts while locked`
                        : ""}
                    </Text>
                    <Button
                      size="1"
                      variant="soft"
                      disabled={changingId === item.id}
                      onClick={() =>
                        onChange({
                          action:
                            item.kind === "lock"
                              ? "unlock"
                              : item.state === "suspended"
                                ? "restore-grant"
                                : "revoke-grant",
                          id: item.id,
                        })
                      }
                    >
                      {item.kind === "lock"
                        ? "Unlock"
                        : item.state === "suspended"
                          ? "Restore"
                          : "Remove"}
                    </Button>
                  </Flex>
                ))}
            </Flex>
          </Card>
        ))
      )}
      {units
        .filter((unit) => unit.authorityRows?.some((row) => row.domain === domain))
        .map((unit) => (
          <Card key={`${unit.kind}:${unit.name}`} size="2">
            <Flex direction="column" gap="2">
              <Heading size="3">{unit.displayName ?? unit.name}</Heading>
              <Text size="2" color="gray">
                Built-in access declared by its developer
              </Text>
              {unit.authorityRows
                ?.filter((row) => row.domain === domain)
                .map((row) => (
                  <Text key={`${row.capability}:${row.resource}`} size="2">
                    {row.action} — {row.resource}
                    {row.tier === "critical" ? " · asks every time" : ""}
                  </Text>
                ))}
            </Flex>
          </Card>
        ))}
    </Flex>
  );
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
            <Badge
              color={
                grant.kind === "capability"
                  ? "blue"
                  : grant.kind === "browser-site"
                    ? "green"
                    : "purple"
              }
              variant="soft"
            >
              {grant.kind === "capability"
                ? "System capability"
                : grant.kind === "browser-site"
                  ? "Website permission"
                  : grant.kind === "credential-use"
                    ? "Credential use"
                    : "Agent choice"}
            </Badge>
          </Flex>
          <Text size="2">{grant.scopeLabel}</Text>
          <dl
            style={{
              margin: 0,
              display: "grid",
              gridTemplateColumns: "minmax(6rem, auto) 1fr",
              gap: "6px 12px",
            }}
          >
            <dt>
              <Text size="1" weight="bold">
                What
              </Text>
            </dt>
            <dd style={{ margin: 0 }}>
              <Text size="2">
                {[grant.capability, grant.resource].filter(Boolean).join(" · ") || grant.scopeLabel}
              </Text>
            </dd>
            <dt>
              <Text size="1" weight="bold">
                Why
              </Text>
            </dt>
            <dd style={{ margin: 0 }}>
              <Text size="2">{grant.why}</Text>
            </dd>
            <dt>
              <Text size="1" weight="bold">
                Approved by
              </Text>
            </dt>
            <dd style={{ margin: 0 }}>
              <Text size="2">{grant.approvedBy}</Text>
            </dd>
            <dt>
              <Text size="1" weight="bold">
                How long
              </Text>
            </dt>
            <dd style={{ margin: 0 }}>
              <Text size="2">{grant.duration}</Text>
            </dd>
            <dt>
              <Text size="1" weight="bold">
                If you revoke it
              </Text>
            </dt>
            <dd style={{ margin: 0 }}>
              <Text size="2">{grant.revokeEffect}</Text>
            </dd>
          </dl>
          {grant.repoPath ? (
            <Text size="1" color="gray">
              {grant.repoPath}
              {grant.effectiveVersion ? ` · version ${grant.effectiveVersion}` : ""}
            </Text>
          ) : null}
          <Text size="1" color="gray">
            Granted {dateLabel(grant.grantedAt)}
            {grant.lastUsedAt ? ` · last used ${dateLabel(grant.lastUsedAt)}` : ""}
            {grant.expiresAt ? ` · expires ${dateLabel(grant.expiresAt)}` : ""}
          </Text>
        </Flex>
        <Button color="red" variant="soft" disabled={revoking} onClick={onRevoke}>
          {revoking ? <Spinner size="1" /> : <TrashIcon />} {revoking ? "Revoking…" : "Revoke"}
        </Button>
      </Flex>
    </Card>
  );
}

function MissionCard({
  mission,
  runs,
  changing,
  onAction,
}: {
  mission: MissionRecord;
  runs: MissionRunRecord[];
  changing: boolean;
  onAction(action: "requestReview" | "pause" | "resume" | "retire"): void;
}) {
  const status =
    mission.state === "needs-reapproval"
      ? "Needs your review"
      : mission.state === "draft"
        ? "Draft — not running"
        : mission.state === "active"
          ? "Active"
          : mission.state === "paused"
            ? "Paused"
            : "Retired";
  const trigger =
    mission.charter.trigger.kind === "manual"
      ? "Runs when you start it"
      : mission.charter.trigger.kind === "cron"
        ? "Runs on its approved schedule"
        : "Runs when its approved event happens";
  return (
    <Card size="3">
      <Flex direction="column" gap="3">
        <Flex justify="between" align="start" gap="3" wrap="wrap">
          <div>
            <Heading size="4">{mission.name}</Heading>
            <Text size="2" color={mission.state === "needs-reapproval" ? "red" : "gray"}>
              {status} · revision {mission.revision}
            </Text>
          </div>
          <Flex gap="2" wrap="wrap">
            {mission.state === "draft" || mission.state === "needs-reapproval" ? (
              <Button disabled={changing} onClick={() => onAction("requestReview")}>
                Review mission
              </Button>
            ) : null}
            {mission.state === "active" ? (
              <Button variant="soft" disabled={changing} onClick={() => onAction("pause")}>
                Pause
              </Button>
            ) : null}
            {mission.state === "paused" ? (
              <Button variant="soft" disabled={changing} onClick={() => onAction("resume")}>
                Resume
              </Button>
            ) : null}
            {mission.state !== "retired" ? (
              <Button
                color="red"
                variant="soft"
                disabled={changing}
                onClick={() => onAction("retire")}
              >
                Retire
              </Button>
            ) : null}
          </Flex>
        </Flex>
        <div>
          <Text as="div" size="1" color="gray">
            What it will do
          </Text>
          <Text as="div" size="2">
            {mission.charter.taskSpec}
          </Text>
        </div>
        <Text size="2">{trigger}</Text>
        <Flex gap="2" wrap="wrap">
          <Badge variant="soft">{mission.permissions.length} toolkit permissions</Badge>
          <Badge variant="soft">
            {mission.charter.toolExposure.evalNetwork === "none"
              ? "No network access"
              : mission.charter.toolExposure.evalNetwork === "declared-origins"
                ? `Can reach ${mission.charter.toolExposure.declaredOrigins.length} approved sites`
                : "Can reach the web"}
          </Badge>
          <Badge variant="soft">Content: {mission.charter.declaredLineageClasses.join(", ")}</Badge>
        </Flex>
        <details>
          <summary>Run timeline</summary>
          <Flex direction="column" gap="2" mt="2">
            {runs.length === 0 ? (
              <Text size="2" color="gray">
                This mission has not run yet.
              </Text>
            ) : (
              runs.map((run) => (
                <Text key={run.runId} size="2">
                  Started {dateLabel(run.startedAt)} ·{" "}
                  {run.finishedAt
                    ? run.outcome === "mission-change-required"
                      ? "Ended early: needed a permission change"
                      : run.outcome === "permission-revoked"
                        ? "Ended early: a permission was removed"
                        : `Finished: ${run.outcome ?? "complete"}`
                    : "Running"}
                </Text>
              ))
            )}
          </Flex>
        </details>
        <Text size="1" color="gray">
          Actions that can’t be undone always wait for you. Like all agents, this mission can’t
          change your safety controls.
        </Text>
      </Flex>
    </Card>
  );
}

function CatalogCard({
  unit,
  profile,
}: {
  unit: WorkspaceUnitStatus;
  profile?: AgentAuthorityProfile;
}) {
  const kind =
    unit.kind === "panel"
      ? "Panel"
      : unit.kind === "app"
        ? "App"
        : unit.kind === "worker"
          ? "Background worker"
          : "Extension";
  const status =
    unit.status === "pending-approval"
      ? "Needs your review"
      : unit.status.charAt(0).toUpperCase() + unit.status.slice(1);
  return (
    <Card size="2">
      <Flex direction="column" gap="2">
        <Flex justify="between" align="start" gap="3" wrap="wrap">
          <div>
            <Heading size="3">{unit.displayName ?? unit.name}</Heading>
            <Text size="2" color="gray">
              {kind} · {status}
              {unit.version ? ` · v${unit.version}` : ""}
            </Text>
          </div>
          {unit.pendingApproval || unit.status === "pending-approval" ? (
            <Badge color="amber">Review pending</Badge>
          ) : null}
        </Flex>
        <Text size="1" color="gray">
          {unit.source}
          {(unit.activeEv ?? unit.ev) ? ` · exact version ${unit.activeEv ?? unit.ev}` : ""}
        </Text>
        {unit.lastError ? (
          <Callout.Root color="red" size="1">
            <Callout.Text>{unit.lastError}</Callout.Text>
          </Callout.Root>
        ) : null}
        <details>
          <summary>What this {kind.toLowerCase()} can do</summary>
          <Flex direction="column" gap="2" mt="2">
            {unit.authorityRows?.length ? (
              (Object.keys(DOMAIN_COPY) as DomainId[]).map((domain) => {
                const rows = unit.authorityRows?.filter((row) => row.domain === domain) ?? [];
                if (rows.length === 0) return null;
                return (
                  <div key={domain}>
                    <Text as="div" size="1" weight="bold">
                      {DOMAIN_COPY[domain]} · declared by its developer
                    </Text>
                    {rows.map((row) => (
                      <Text
                        as="div"
                        key={`${row.capability}:${row.resource}`}
                        size="2"
                        color="gray"
                      >
                        {row.action} — {row.resource}
                        {row.tier === "critical" ? " · asks every time" : ""}
                      </Text>
                    ))}
                  </div>
                );
              })
            ) : (
              <Text size="2" color="gray">
                This version declares no protected host access.
              </Text>
            )}
            {unit.isAgent && profile ? (
              <div>
                <Text as="div" size="1" weight="bold">
                  Permissions you chose for this agent
                </Text>
                <Text as="div" size="2" color="gray">
                  {profile.summary}
                </Text>
              </div>
            ) : null}
          </Flex>
        </details>
      </Flex>
    </Card>
  );
}

function DecisionCard({ decision }: { decision: GovernanceDecision }) {
  const target =
    decision.resource?.value ??
    decision.resource?.key ??
    decision.resource?.capability ??
    decision.requestedBy.callerId;
  return (
    <Card size="2">
      <Flex justify="between" align="start" gap="3" wrap="wrap">
        <div>
          <Heading size="3">{decision.requestedBy.callerId}</Heading>
          <Text as="div" size="2">
            {decision.granted ? "Allowed" : "Did not allow"} · {target}
          </Text>
          <Text as="div" size="1" color="gray">
            {decision.decision}
            {decision.grantScopeStored ? ` · saved for ${decision.grantScopeStored}` : ""}
            {" · "}
            {decision.resolvedBy.handle} · {dateLabel(decision.resolvedAt)}
          </Text>
        </div>
        <Badge color={decision.granted ? "green" : "red"} variant="soft">
          {decision.approvalKind}
        </Badge>
      </Flex>
    </Card>
  );
}

function PermissionsPage() {
  const [grants, setGrants] = useState<SavedPermissionGrant[]>([]);
  const [profiles, setProfiles] = useState<AgentAuthorityProfile[]>([]);
  const [missions, setMissions] = useState<MissionRecord[]>([]);
  const [units, setUnits] = useState<WorkspaceUnitStatus[]>([]);
  const [decisions, setDecisions] = useState<GovernanceDecision[]>([]);
  const [missionRuns, setMissionRuns] = useState<Record<string, MissionRunRecord[]>>({});
  const [view, setView] = useState<"catalog" | "agents" | "domains" | "missions" | "recent">(
    "catalog"
  );
  const [domain, setDomain] = useState<DomainId>("sharing");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [safety, setSafety] = useState<AuthoritySafetyStatus>({
    workspaceLocked: false,
    activeAgentCount: 0,
    pendingAcquisitionCount: 0,
  });
  const [statusMessage, setStatusMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextGrants, nextProfiles, nextSafety, nextMissions, nextUnits, nextDecisions] =
        await Promise.all([
          rpc.call<SavedPermissionGrant[]>("main", "permissions.list", []),
          rpc.call<AgentAuthorityProfile[]>("main", "permissions.listAgentProfiles", []),
          rpc.call<AuthoritySafetyStatus>("main", "permissions.safetyStatus", []),
          rpc.call<MissionRecord[]>("main", "mission.list", []),
          rpc.call<WorkspaceUnitStatus[]>("main", "workspace.units.list", []),
          rpc.call<GovernanceDecision[]>("main", "governance.list", [
            { filter: { recordKind: "approval" }, limit: 100 },
          ]),
        ]);
      setGrants(nextGrants);
      setProfiles(nextProfiles);
      setSafety(nextSafety);
      setMissions(nextMissions);
      setUnits(nextUnits);
      setDecisions(nextDecisions);
      setMissionRuns(
        Object.fromEntries(
          await Promise.all(
            nextMissions.map(async (mission) => [
              mission.missionId,
              await rpc.call<MissionRunRecord[]>("main", "mission.listRuns", [mission.missionId]),
            ])
          )
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const updateMission = useCallback(
    async (mission: MissionRecord, action: "requestReview" | "pause" | "resume" | "retire") => {
      setRevokingId(mission.missionId);
      setError(null);
      try {
        await rpc.call("main", `mission.${action}`, [mission.missionId]);
        await load();
      } catch (err) {
        setError(
          `Couldn't update this mission: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setRevokingId(null);
      }
    },
    [load]
  );

  const updateProfile = useCallback(async (request: Record<string, unknown>) => {
    const id = String(request["id"] ?? request["bindingId"] ?? "profile");
    setRevokingId(id);
    setError(null);
    try {
      await rpc.call("main", "permissions.updateAgentProfile", [request]);
      setProfiles(
        await rpc.call<AgentAuthorityProfile[]>("main", "permissions.listAgentProfiles", [])
      );
      setGrants(await rpc.call<SavedPermissionGrant[]>("main", "permissions.list", []));
      setSafety(await rpc.call<AuthoritySafetyStatus>("main", "permissions.safetyStatus", []));
      setStatusMessage("Agent authority settings updated.");
    } catch (err) {
      setError(`Couldn't change this setting: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRevokingId(null);
    }
  }, []);

  const setWorkspaceLock = useCallback(
    async (locked: boolean) => {
      setRevokingId("workspace-authority-lock");
      setError(null);
      try {
        const next = await rpc.call<AuthoritySafetyStatus>(
          "main",
          "permissions.setWorkspaceAuthorityLock",
          [{ locked }]
        );
        setSafety(next);
        setStatusMessage(
          locked
            ? "Workspace authority locked. Active agent work was stopped."
            : "Workspace authority unlocked. Agents may work when asked."
        );
        await load();
      } catch (err) {
        setError(
          `Couldn't ${locked ? "lock" : "unlock"} workspace authority: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        setRevokingId(null);
      }
    },
    [load]
  );

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
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
        }}
      >
        {statusMessage}
      </div>
      <Section>
        <Flex direction="column" gap="3">
          <Flex justify="between" align="center" gap="3" wrap="wrap">
            <div>
              <Flex align="center" gap="2" wrap="wrap">
                <Heading size="3">Emergency agent authority lock</Heading>
                <Badge color={safety.workspaceLocked ? "red" : "green"}>
                  {safety.workspaceLocked ? "Locked" : "Ready"}
                </Badge>
              </Flex>
              <Text as="div" size="2" color="gray">
                {safety.workspaceLocked
                  ? "Every agent is blocked from protected workspace actions."
                  : `${safety.activeAgentCount} active agent${safety.activeAgentCount === 1 ? "" : "s"} · ${safety.pendingAcquisitionCount} approval${safety.pendingAcquisitionCount === 1 ? "" : "s"} waiting`}
              </Text>
            </div>
            <Button
              color={safety.workspaceLocked ? "gray" : "red"}
              variant="soft"
              disabled={revokingId === "workspace-authority-lock"}
              onClick={() => void setWorkspaceLock(!safety.workspaceLocked)}
            >
              <LockClosedIcon />
              {safety.workspaceLocked ? "Unlock agent authority" : "Lock all agent authority"}
            </Button>
          </Flex>
          <Text size="1" color="gray">
            Locking cancels pending permission requests, interrupts active agent transports, and
            prevents new protected work. Your own permission controls remain available.
          </Text>
        </Flex>
      </Section>
      <Section>
        <Flex direction="column" gap="3">
          <Text size="2" color="gray">
            See what each agent can do, make it ask first again, or keep a lasting “never” choice.
            One-time decisions appear only in Recent decisions.
          </Text>
          <div style={{ maxWidth: "100%", overflowX: "auto" }}>
            <SegmentedControl.Root
              aria-label="Permission view"
              value={view}
              onValueChange={(value) =>
                setView(value as "catalog" | "agents" | "domains" | "missions" | "recent")
              }
            >
              <SegmentedControl.Item value="catalog">Catalog</SegmentedControl.Item>
              <SegmentedControl.Item value="agents">Agents</SegmentedControl.Item>
              <SegmentedControl.Item value="domains">By area</SegmentedControl.Item>
              <SegmentedControl.Item value="missions">Missions</SegmentedControl.Item>
              <SegmentedControl.Item value="recent">Recent decisions</SegmentedControl.Item>
            </SegmentedControl.Root>
          </div>
          {view === "domains" ? (
            <label>
              <Text as="div" size="1" color="gray" mb="1">
                Permission area
              </Text>
              <select
                aria-label="Permission area"
                value={domain}
                onChange={(event) => setDomain(event.currentTarget.value as DomainId)}
                style={{
                  width: "100%",
                  minHeight: 36,
                  borderRadius: 6,
                  padding: "0 10px",
                  color: "inherit",
                  background: "var(--color-panel-solid)",
                  border: "1px solid var(--gray-a7)",
                }}
              >
                {(Object.keys(DOMAIN_COPY) as DomainId[]).map((value) => (
                  <option key={value} value={value}>
                    {DOMAIN_COPY[value]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </Flex>
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
      {!loading && !error && view === "agents" && profiles.length === 0 ? (
        <Section>
          <Heading size="3" mb="1">
            Every agent asks first
          </Heading>
          <Text size="2" color="gray">
            No agent has lasting permissions or “never” choices yet. Profiles appear here as you
            make those decisions.
          </Text>
        </Section>
      ) : null}
      <Flex direction="column" gap="3">
        {view === "catalog" ? (
          <>
            {(["agent", "worker", "panel", "app", "extension"] as const).map((kind) => {
              const matching = units.filter((unit) =>
                kind === "agent"
                  ? unit.kind === "worker" && unit.isAgent
                  : kind === "worker"
                    ? unit.kind === "worker" && !unit.isAgent
                    : unit.kind === kind
              );
              if (matching.length === 0) return null;
              return (
                <Flex key={kind} direction="column" gap="2">
                  <Heading size="3">
                    {kind === "agent"
                      ? "Agents"
                      : kind === "worker"
                        ? "Workers"
                        : kind === "panel"
                          ? "Panels"
                          : kind === "app"
                            ? "Apps"
                            : "Extensions"}
                  </Heading>
                  {matching.map((unit) => (
                    <CatalogCard
                      key={`${unit.kind}:${unit.name}`}
                      unit={unit}
                      profile={profiles.find(
                        (profile) =>
                          profile.name.toLowerCase() ===
                          (unit.displayName ?? unit.name).toLowerCase()
                      )}
                    />
                  ))}
                </Flex>
              );
            })}
            {missions.length > 0 ? (
              <Flex direction="column" gap="2">
                <Heading size="3">Missions</Heading>
                {missions.map((mission) => (
                  <MissionCard
                    key={mission.missionId}
                    mission={mission}
                    runs={missionRuns[mission.missionId] ?? []}
                    changing={revokingId === mission.missionId}
                    onAction={(action) => void updateMission(mission, action)}
                  />
                ))}
              </Flex>
            ) : null}
          </>
        ) : view === "agents" ? (
          profiles.map((profile) => (
            <ProfileCard
              key={profile.bindingId}
              profile={profile}
              changingId={revokingId}
              onChange={(request) => void updateProfile(request)}
            />
          ))
        ) : view === "domains" ? (
          <DomainPivot
            domain={domain}
            profiles={profiles}
            units={units}
            changingId={revokingId}
            onChange={(request) => void updateProfile(request)}
          />
        ) : view === "missions" ? (
          missions.map((mission) => (
            <MissionCard
              key={mission.missionId}
              mission={mission}
              runs={missionRuns[mission.missionId] ?? []}
              changing={revokingId === mission.missionId}
              onAction={(action) => void updateMission(mission, action)}
            />
          ))
        ) : decisions.length > 0 ? (
          decisions.map((decision) => (
            <DecisionCard key={decision.approvalId} decision={decision} />
          ))
        ) : (
          <Card size="2">
            <Text size="2" color="gray">
              No authority decisions have been recorded yet.
            </Text>
          </Card>
        )}
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
