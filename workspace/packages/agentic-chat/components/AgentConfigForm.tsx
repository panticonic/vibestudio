import { useCallback, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  SegmentedControl,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { CheckIcon } from "@radix-ui/react-icons";
import type {
  AgentApprovalLevel,
  AgentRespondPolicy,
  AgentThinkingLevel,
  ModelCatalog,
} from "@workspace/agentic-core";
import type { DefaultAgentConfig } from "@workspace/model-catalog/catalog";
import { ModelPicker } from "./ModelPicker";

export interface AgentConfigDraft {
  model: string;
  thinkingLevel?: AgentThinkingLevel;
  approvalLevel?: AgentApprovalLevel;
  respondPolicy?: AgentRespondPolicy;
  respondFrom?: string[];
  handle?: string;
  systemPrompt?: string;
}

export interface AgentConfigFormProps {
  catalog: ModelCatalog | null;
  connectedRefs: ReadonlySet<string>;
  value: AgentConfigDraft;
  onChange: (next: AgentConfigDraft) => void;
  /** False in edit mode — model is read-only (switching model needs a restart). */
  modelEditable?: boolean;
  /** Current workspace default agent config — drives the "Save as defaults" state. */
  defaultAgentConfig?: DefaultAgentConfig | null;
  /** Explicitly persist the full config (model + behavior) as the workspace
   *  default. When absent, the "Save as defaults" control is hidden. */
  onSaveAsDefault?: (config: DefaultAgentConfig) => void | Promise<void>;
  /** Show the reactiveness control (only meaningful with >1 agent in channel). */
  showReactiveness?: boolean;
  /** Show the @-mention handle field (matters in multi-agent channels). */
  showHandle?: boolean;
  /** Other participants, for the "specific people" respond policy. */
  participants?: Array<{ id: string; label: string }>;
}

const THINKING_LABELS: Record<AgentThinkingLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const APPROVAL_LABELS: Record<string, string> = {
  "0": "Manual",
  "1": "Auto-safe",
  "2": "Full-auto",
};

function FieldLabel({ children, hint }: { children: string; hint?: string }) {
  return (
    <Box mb="1">
      <Text size="2" weight="medium">
        {children}
      </Text>
      {hint && (
        <Text size="1" color="gray" as="p" style={{ margin: 0 }}>
          {hint}
        </Text>
      )}
    </Box>
  );
}

export function AgentConfigForm({
  catalog,
  connectedRefs,
  value,
  onChange,
  modelEditable = true,
  defaultAgentConfig,
  onSaveAsDefault,
  showReactiveness = false,
  showHandle = false,
  participants = [],
}: AgentConfigFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const set = (patch: Partial<AgentConfigDraft>) => onChange({ ...value, ...patch });

  const handleSaveAsDefault = useCallback(async () => {
    if (!onSaveAsDefault || !value.model) return;
    const config: DefaultAgentConfig = {
      model: value.model,
      ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}),
      approvalLevel: value.approvalLevel ?? 2,
    };
    setSavingDefault(true);
    try {
      await onSaveAsDefault(config);
    } catch (err) {
      console.warn("[AgentConfigForm] Failed to save default agent config:", err);
    } finally {
      setSavingDefault(false);
    }
  }, [onSaveAsDefault, value.model, value.thinkingLevel, value.approvalLevel]);

  const selectedModel = useMemo(
    () => catalog?.models.find((m) => m.ref === value.model) ?? null,
    [catalog, value.model]
  );
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];
  const showEffort = !!selectedModel?.reasoning && thinkingLevels.length > 0;
  const effort: AgentThinkingLevel =
    value.thinkingLevel && thinkingLevels.includes(value.thinkingLevel)
      ? value.thinkingLevel
      : thinkingLevels[0] ?? "medium";

  const policy: AgentRespondPolicy = value.respondPolicy ?? "all";

  // Does the current draft match the saved workspace defaults (model + the
  // behavior fields we persist)? Drives the "Save as defaults" footer.
  const savedDefaultsMatch =
    !!defaultAgentConfig &&
    value.model === defaultAgentConfig.model &&
    (value.thinkingLevel ?? null) === (defaultAgentConfig.thinkingLevel ?? null) &&
    (value.approvalLevel ?? 2) === (defaultAgentConfig.approvalLevel ?? 2);

  return (
    <Flex direction="column" gap="4">
      {/* Model */}
      <Box>
        <FieldLabel>Model</FieldLabel>
        {modelEditable ? (
          <ModelPicker
            catalog={catalog}
            connectedRefs={connectedRefs}
            value={value.model}
            onChange={(ref) => set({ model: ref })}
          />
        ) : (
          <Flex align="center" gap="2">
            <Badge variant="soft" color="gray" size="2">
              {selectedModel?.name ?? value.model}
            </Badge>
            <Text size="1" color="gray">
              Switching the model restarts this agent.
            </Text>
          </Flex>
        )}
      </Box>

      {/* Effort — only for reasoning models */}
      {showEffort && (
        <Box>
          <FieldLabel hint="How much the model thinks before answering.">Effort</FieldLabel>
          <SegmentedControl.Root
            value={effort}
            onValueChange={(v) => set({ thinkingLevel: v as AgentThinkingLevel })}
          >
            {thinkingLevels.map((lvl) => (
              <SegmentedControl.Item key={lvl} value={lvl}>
                {THINKING_LABELS[lvl]}
              </SegmentedControl.Item>
            ))}
          </SegmentedControl.Root>
        </Box>
      )}

      {/* Autonomy */}
      <Box>
        <FieldLabel hint="Manual asks before each tool call; Full-auto runs everything.">
          Autonomy
        </FieldLabel>
        <SegmentedControl.Root
          value={String(value.approvalLevel ?? 2)}
          onValueChange={(v) => set({ approvalLevel: Number(v) as AgentApprovalLevel })}
        >
          <SegmentedControl.Item value="0">{APPROVAL_LABELS["0"]}</SegmentedControl.Item>
          <SegmentedControl.Item value="1">{APPROVAL_LABELS["1"]}</SegmentedControl.Item>
          <SegmentedControl.Item value="2">{APPROVAL_LABELS["2"]}</SegmentedControl.Item>
        </SegmentedControl.Root>
      </Box>

      {/* Reactiveness — only with >1 agent */}
      {showReactiveness && (
        <Box>
          <FieldLabel hint="When this agent replies in a multi-agent channel.">
            Reactiveness
          </FieldLabel>
          <SegmentedControl.Root
            value={
              policy === "all"
                ? "all"
                : policy === "from-participants"
                  ? "specific"
                  : policy === "mentioned-or-followup"
                    ? "followup"
                    : "mentioned"
            }
            onValueChange={(v) =>
              set({
                respondPolicy:
                  v === "all"
                    ? "all"
                    : v === "specific"
                      ? "from-participants"
                      : v === "followup"
                        ? "mentioned-or-followup"
                        : "mentioned",
              })
            }
          >
            <SegmentedControl.Item value="all">Everything</SegmentedControl.Item>
            <SegmentedControl.Item value="mentioned">@mention</SegmentedControl.Item>
            <SegmentedControl.Item value="followup">Mention + reply</SegmentedControl.Item>
            {participants.length > 0 && (
              <SegmentedControl.Item value="specific">Specific</SegmentedControl.Item>
            )}
          </SegmentedControl.Root>
          {policy === "from-participants" && participants.length > 0 && (
            <Flex direction="column" gap="1" mt="2">
              {participants.map((p) => {
                const checked = (value.respondFrom ?? []).includes(p.id);
                return (
                  <Text as="label" size="2" key={p.id}>
                    <Flex align="center" gap="2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(c) => {
                          const cur = new Set(value.respondFrom ?? []);
                          if (c) cur.add(p.id);
                          else cur.delete(p.id);
                          set({ respondFrom: [...cur] });
                        }}
                      />
                      {p.label}
                    </Flex>
                  </Text>
                );
              })}
            </Flex>
          )}
        </Box>
      )}

      {/* Handle — matters for @-mentions in multi-agent channels */}
      {showHandle && (
        <Box>
          <FieldLabel hint="Used to @mention this agent.">Handle</FieldLabel>
          <TextField.Root
            value={value.handle ?? ""}
            onChange={(e) => set({ handle: e.target.value })}
            placeholder="agent"
          />
        </Box>
      )}

      {/* Advanced */}
      <Box>
        <Text
          size="1"
          color="gray"
          style={{ cursor: "pointer" }}
          onClick={() => setShowAdvanced((s) => !s)}
        >
          {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
        </Text>
        {showAdvanced && (
          <Box mt="2">
            <FieldLabel hint="Appended to the workspace system prompt.">
              System prompt (optional)
            </FieldLabel>
            <TextArea
              value={value.systemPrompt ?? ""}
              onChange={(e) => set({ systemPrompt: e.target.value })}
              placeholder="Extra instructions for this agent…"
              rows={4}
            />
          </Box>
        )}
      </Box>

      {/* Save-as-defaults — the ONLY path that writes the workspace default agent
          config (model + behavior). The button appears only when the draft
          differs from the saved defaults; when it matches, a quiet indicator
          shows instead. Hidden entirely when the host doesn't support it. */}
      {modelEditable && onSaveAsDefault && value.model && defaultAgentConfig && (
        <Box pt="1">
          {savedDefaultsMatch ? (
            <Flex align="center" gap="1">
              <CheckIcon style={{ color: "var(--green-9)" }} />
              <Text size="1" color="gray">
                These are your workspace defaults
              </Text>
            </Flex>
          ) : (
            <Button
              size="1"
              variant="soft"
              color="gray"
              loading={savingDefault}
              onClick={() => void handleSaveAsDefault()}
            >
              Save as workspace defaults
            </Button>
          )}
        </Box>
      )}
    </Flex>
  );
}
