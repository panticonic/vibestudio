import { useMemo, useState } from "react";
import { Badge, Box, Button, Flex, Popover, ScrollArea, Text, TextField } from "@radix-ui/themes";
import {
  CheckIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  LightningBoltIcon,
  ImageIcon,
} from "@radix-ui/react-icons";
import type { ModelCatalog, ModelCatalogEntry } from "@workspace/agentic-core";

export interface ModelPickerProps {
  catalog: ModelCatalog | null;
  /** Model refs the panel has a usable credential for. */
  connectedRefs: ReadonlySet<string>;
  /** Currently selected "provider:modelId" ref. */
  value: string;
  onChange: (ref: string) => void;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function ModelChips({ model }: { model: ModelCatalogEntry }) {
  return (
    <Flex gap="2" align="center" wrap="wrap">
      {model.reasoning && (
        <Badge color="purple" variant="soft" size="1">
          <LightningBoltIcon width="10" height="10" /> reasoning
        </Badge>
      )}
      {model.vision && (
        <Badge color="blue" variant="soft" size="1">
          <ImageIcon width="10" height="10" /> vision
        </Badge>
      )}
      <Badge color="gray" variant="soft" size="1">
        {formatContext(model.contextWindow)}
      </Badge>
    </Flex>
  );
}

function ModelRow({
  model,
  selected,
  connected,
  onSelect,
}: {
  model: ModelCatalogEntry;
  selected: boolean;
  connected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "block",
        width: "100%",
        borderRadius: 6,
        padding: "6px 8px",
        background: selected ? "var(--accent-a3)" : undefined,
        opacity: connected ? 1 : 0.7,
      }}
    >
      <Flex justify="between" align="center" gap="2">
        <Box style={{ minWidth: 0 }}>
          <Flex align="center" gap="2">
            {selected && <CheckIcon />}
            <Text size="2" weight="medium" truncate>
              {model.name}
            </Text>
          </Flex>
          <Text size="1" color="gray">
            {model.provider}
            {!connected && (model.connectable ? " · not connected" : " · no credential")}
          </Text>
        </Box>
        <ModelChips model={model} />
      </Flex>
    </button>
  );
}

export function ModelPicker({ catalog, connectedRefs, value, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const models = catalog?.models ?? [];
  const selected = models.find((m) => m.ref === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        m.ref.toLowerCase().includes(q)
    );
  }, [models, query]);

  const connected = useMemo(
    () => filtered.filter((m) => connectedRefs.has(m.ref)),
    [filtered, connectedRefs]
  );
  const recommended = useMemo(
    () => filtered.filter((m) => m.recommended && !connectedRefs.has(m.ref)),
    [filtered, connectedRefs]
  );

  const select = (ref: string) => {
    onChange(ref);
    setOpen(false);
  };

  const renderGroup = (label: string, list: ModelCatalogEntry[]) =>
    list.length > 0 && (
      <Box mb="2">
        <Text size="1" color="gray" weight="bold" style={{ textTransform: "uppercase" }}>
          {label}
        </Text>
        <Flex direction="column" gap="1" mt="1">
          {list.map((m) => (
            <ModelRow
              key={m.ref}
              model={m}
              selected={m.ref === value}
              connected={connectedRefs.has(m.ref)}
              onSelect={() => select(m.ref)}
            />
          ))}
        </Flex>
      </Box>
    );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button variant="surface" color="gray" style={{ justifyContent: "space-between", width: "100%" }}>
          <Flex align="center" gap="2" style={{ minWidth: 0 }}>
            <Text truncate>{selected ? selected.name : value || "Choose a model"}</Text>
            {selected && !connectedRefs.has(selected.ref) && (
              <Badge color="amber" variant="soft" size="1">
                not connected
              </Badge>
            )}
          </Flex>
          <ChevronDownIcon />
        </Button>
      </Popover.Trigger>
      <Popover.Content style={{ width: "min(420px, calc(100vw - 32px))" }}>
        <TextField.Root
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          mb="2"
          autoFocus
        >
          <TextField.Slot>
            <MagnifyingGlassIcon />
          </TextField.Slot>
        </TextField.Root>
        <ScrollArea type="auto" scrollbars="vertical" style={{ maxHeight: 340 }}>
          <Box pr="2">
            {renderGroup("Connected", connected)}
            {renderGroup("Recommended", recommended)}
            {showAll ? (
              renderGroup("All models", filtered)
            ) : (
              <Button
                variant="ghost"
                size="1"
                onClick={() => setShowAll(true)}
                style={{ marginTop: 4 }}
              >
                Show all {filtered.length} models
              </Button>
            )}
            {filtered.length === 0 && (
              <Text size="2" color="gray">
                No models match “{query}”.
              </Text>
            )}
          </Box>
        </ScrollArea>
      </Popover.Content>
    </Popover.Root>
  );
}
