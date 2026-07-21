/**
 * FrontmatterEditor — Spectrolite's presentation for the document's YAML
 * frontmatter block.
 *
 * Injected into the vendored {@link FrontmatterNode} via the mdx-editor-core
 * `DescriptorProvider` seam (see {@link MdxLexicalEditor}), so the frontmatter
 * reads as distinct chrome above the prose rather than as an unstyled textarea
 * embedded in the document body. It offers:
 *  - a **structured** field editor (scalar keys as typed inputs; the
 *    `dependencies` map as an add/remove package list), and
 *  - a **raw YAML** fallback with live validation, for anything the structured
 *    view can't represent.
 *
 * The block is collapsible (but not deletable — frontmatter is a required part
 * of every document).
 *
 * State model: `fields` is the source of truth while editing; every mutation
 * re-serializes to YAML and calls `onChange`. External replacements (agent
 * edits, undo, document reload) arrive as a changed `yaml` prop and re-seed both
 * representations — `lastEmitted` distinguishes those from our own echoes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Callout, Flex, IconButton, Text, TextArea, TextField, Tooltip } from "@radix-ui/themes";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import * as YAML from "yaml";
import type { FrontmatterEditorProps } from "@workspace/mdx-editor-core";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type FieldKind = "scalar" | "deps" | "complex";

interface DepRow {
  id: string;
  name: string;
  ref: string;
}

interface Field {
  id: string;
  key: string;
  kind: FieldKind;
  /** Text value for `scalar` fields (typed back to YAML on serialize). */
  scalar: string;
  /** Package rows for the `dependencies` field. */
  deps: DepRow[];
  /** The original value for `complex` (non-scalar, non-deps) fields, edited only in YAML mode. */
  complex: unknown;
}

let uidCounter = 0;
const nextId = (): string => `fm-${(uidCounter += 1)}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a typed scalar input back to its natural YAML type (number/bool/null/string). */
function parseScalar(text: string): unknown {
  if (text.trim() === "") return "";
  try {
    const value = YAML.parse(text) as unknown;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  } catch {
    /* fall through to raw string */
  }
  return text;
}

function fieldFromEntry(key: string, value: unknown): Field {
  const base = { id: nextId(), key, scalar: "", deps: [] as DepRow[], complex: null as unknown };
  if (key === "dependencies" && isPlainObject(value)) {
    return {
      ...base,
      kind: "deps",
      deps: Object.entries(value).map(([name, ref]) => ({
        id: nextId(),
        name,
        ref: typeof ref === "string" ? ref : String(ref ?? ""),
      })),
    };
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return { ...base, kind: "scalar", scalar: value === null ? "" : String(value) };
  }
  return { ...base, kind: "complex", complex: value };
}

/** Parse frontmatter YAML into structured fields, or report it can't be structured. */
function toFields(yaml: string): { fields: Field[] } | { invalid: true } {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yaml) ?? {};
  } catch {
    return { invalid: true };
  }
  if (!isPlainObject(parsed)) return { invalid: true };
  return { fields: Object.entries(parsed).map(([key, value]) => fieldFromEntry(key, value)) };
}

/** Serialize structured fields back to frontmatter YAML (inner body, no `---` fences). */
function serialize(fields: Field[]): string {
  const obj: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.key.trim();
    if (!key) continue;
    if (field.kind === "deps") {
      const deps: Record<string, string> = {};
      for (const row of field.deps) {
        const name = row.name.trim();
        if (name) deps[name] = row.ref;
      }
      obj[key] = deps;
    } else if (field.kind === "complex") {
      obj[key] = field.complex;
    } else {
      obj[key] = parseScalar(field.scalar);
    }
  }
  return YAML.stringify(obj).replace(/\n$/, "");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FrontmatterEditor({ yaml, onChange }: FrontmatterEditorProps): JSX.Element {
  // Seed the structured/raw representations from the initial YAML exactly once;
  // later external replacements are reconciled by the effect below.
  const [fields, setFields] = useState<Field[]>(() => {
    const parsed = toFields(yaml);
    return "fields" in parsed ? parsed.fields : [];
  });
  const [mode, setMode] = useState<"fields" | "raw">(() =>
    "fields" in toFields(yaml) ? "fields" : "raw"
  );
  const [rawText, setRawText] = useState(yaml);
  const [rawError, setRawError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const lastEmitted = useRef(yaml);

  // Re-seed both representations when the block is replaced from outside (agent
  // edit / undo / reload) — but not when the change is our own echo.
  useEffect(() => {
    if (yaml === lastEmitted.current) return;
    lastEmitted.current = yaml;
    setRawText(yaml);
    setRawError(null);
    const parsed = toFields(yaml);
    if ("fields" in parsed) setFields(parsed.fields);
    else setMode("raw");
  }, [yaml]);

  const emit = useCallback(
    (next: Field[]) => {
      setFields(next);
      const text = serialize(next);
      lastEmitted.current = text;
      setRawText(text);
      onChange(text);
    },
    [onChange]
  );

  const patch = useCallback(
    (id: string, updater: (field: Field) => Field) => {
      emit(fields.map((field) => (field.id === id ? updater(field) : field)));
    },
    [emit, fields]
  );

  const addField = useCallback(() => {
    emit([...fields, { id: nextId(), key: "", kind: "scalar", scalar: "", deps: [], complex: null }]);
  }, [emit, fields]);

  const removeField = useCallback(
    (id: string) => emit(fields.filter((field) => field.id !== id)),
    [emit, fields]
  );

  const addPackage = useCallback(() => {
    const existing = fields.find((field) => field.kind === "deps");
    const row: DepRow = { id: nextId(), name: "", ref: "" };
    if (existing) {
      patch(existing.id, (field) => ({ ...field, deps: [...field.deps, row] }));
      return;
    }
    emit([
      ...fields,
      { id: nextId(), key: "dependencies", kind: "deps", scalar: "", deps: [row], complex: null },
    ]);
  }, [emit, fields, patch]);

  const onRawChange = useCallback(
    (text: string) => {
      setRawText(text);
      try {
        YAML.parse(text); // throws on malformed YAML
        setRawError(null);
        lastEmitted.current = text;
        const parsed = toFields(text);
        if ("fields" in parsed) setFields(parsed.fields);
        onChange(text);
      } catch (err) {
        setRawError(err instanceof Error ? err.message : String(err));
      }
    },
    [onChange]
  );

  const showFields = useCallback(() => {
    const parsed = toFields(rawText);
    if ("fields" in parsed) {
      setFields(parsed.fields);
      setRawError(null);
      setMode("fields");
    } else {
      setRawError("This YAML isn't a key/value mapping — edit it here.");
    }
  }, [rawText]);

  const showRaw = useCallback(() => {
    if (rawError === null) setRawText(serialize(fields));
    setMode("raw");
  }, [fields, rawError]);

  const hasDeps = fields.some((field) => field.kind === "deps");

  return (
    <Box className="spectrolite-frontmatter" data-testid="spectrolite-frontmatter">
      <Flex align="center" gap="2" className="spectrolite-frontmatter-header">
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          aria-label={collapsed ? "Expand properties" : "Collapse properties"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </IconButton>
        <Text size="1" weight="medium" className="spectrolite-frontmatter-title">
          Properties
        </Text>
        <Box flexGrow="1" />
        <Flex className="spectrolite-frontmatter-toggle" role="tablist" aria-label="Editing mode">
          <Button
            size="1"
            variant={mode === "fields" ? "soft" : "ghost"}
            color="gray"
            role="tab"
            aria-selected={mode === "fields"}
            onClick={showFields}
          >
            Fields
          </Button>
          <Button
            size="1"
            variant={mode === "raw" ? "soft" : "ghost"}
            color="gray"
            role="tab"
            aria-selected={mode === "raw"}
            onClick={showRaw}
          >
            YAML
          </Button>
        </Flex>
      </Flex>

      {collapsed ? null : (
        <Box className="spectrolite-frontmatter-body">
          {mode === "raw" ? (
            <Flex direction="column" gap="2">
              <TextArea
                className="spectrolite-frontmatter-yaml"
                value={rawText}
                spellCheck={false}
                resize="vertical"
                rows={Math.max(3, rawText.split("\n").length)}
                aria-label="Frontmatter YAML"
                onChange={(event) => onRawChange(event.target.value)}
              />
              {rawError ? (
                <Callout.Root color="red" size="1" role="alert">
                  <Callout.Icon>
                    <ExclamationTriangleIcon />
                  </Callout.Icon>
                  <Callout.Text>{rawError}</Callout.Text>
                </Callout.Root>
              ) : null}
            </Flex>
          ) : (
            <Flex direction="column" gap="2">
              {fields.length === 0 ? (
                <Text size="1" color="gray">
                  No properties yet.
                </Text>
              ) : (
                fields.map((field) =>
                  field.kind === "deps" ? (
                    <DepsField key={field.id} field={field} onPatch={patch} onRemove={removeField} />
                  ) : (
                    <ScalarField
                      key={field.id}
                      field={field}
                      onPatch={patch}
                      onRemove={removeField}
                    />
                  )
                )
              )}
              <Flex gap="2" mt="1">
                <Button size="1" variant="ghost" color="gray" onClick={addField}>
                  <PlusIcon /> Add field
                </Button>
                {!hasDeps ? (
                  <Button size="1" variant="ghost" color="gray" onClick={addPackage}>
                    <PlusIcon /> Add package
                  </Button>
                ) : null}
              </Flex>
            </Flex>
          )}
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Field rows
// ---------------------------------------------------------------------------

function ScalarField({
  field,
  onPatch,
  onRemove,
}: {
  field: Field;
  onPatch: (id: string, updater: (field: Field) => Field) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const complex = field.kind === "complex";
  return (
    <Flex align="center" gap="2" className="spectrolite-frontmatter-row">
      <TextField.Root
        size="1"
        className="spectrolite-frontmatter-key"
        placeholder="key"
        value={field.key}
        aria-label="Property name"
        onChange={(event) => onPatch(field.id, (f) => ({ ...f, key: event.target.value }))}
      />
      {complex ? (
        <Tooltip content="Nested value — edit in YAML mode">
          <TextField.Root
            size="1"
            className="spectrolite-frontmatter-value"
            value={YAML.stringify(field.complex).replace(/\n$/, "")}
            readOnly
            aria-label="Property value (edit in YAML mode)"
          />
        </Tooltip>
      ) : (
        <TextField.Root
          size="1"
          className="spectrolite-frontmatter-value"
          placeholder="value"
          value={field.scalar}
          aria-label="Property value"
          onChange={(event) => onPatch(field.id, (f) => ({ ...f, scalar: event.target.value }))}
        />
      )}
      <IconButton
        size="1"
        variant="ghost"
        color="gray"
        aria-label="Remove property"
        onClick={() => onRemove(field.id)}
      >
        <Cross2Icon />
      </IconButton>
    </Flex>
  );
}

function DepsField({
  field,
  onPatch,
  onRemove,
}: {
  field: Field;
  onPatch: (id: string, updater: (field: Field) => Field) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const setRow = (rowId: string, updater: (row: DepRow) => DepRow) =>
    onPatch(field.id, (f) => ({
      ...f,
      deps: f.deps.map((row) => (row.id === rowId ? updater(row) : row)),
    }));
  const removeRow = (rowId: string) =>
    onPatch(field.id, (f) => ({ ...f, deps: f.deps.filter((row) => row.id !== rowId) }));
  const addRow = () =>
    onPatch(field.id, (f) => ({ ...f, deps: [...f.deps, { id: nextId(), name: "", ref: "" }] }));

  return (
    <Box className="spectrolite-frontmatter-deps">
      <Flex align="center" gap="2" className="spectrolite-frontmatter-row">
        <Text size="1" weight="medium" color="gray" className="spectrolite-frontmatter-key">
          dependencies
        </Text>
        <Box flexGrow="1" />
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          aria-label="Remove dependencies"
          onClick={() => onRemove(field.id)}
        >
          <Cross2Icon />
        </IconButton>
      </Flex>
      <Flex direction="column" gap="1" className="spectrolite-frontmatter-deprows">
        {field.deps.map((row) => (
          <Flex align="center" gap="2" key={row.id} className="spectrolite-frontmatter-row">
            <TextField.Root
              size="1"
              className="spectrolite-frontmatter-depname"
              placeholder="package"
              value={row.name}
              aria-label="Package name"
              onChange={(event) => setRow(row.id, (r) => ({ ...r, name: event.target.value }))}
            />
            <TextField.Root
              size="1"
              className="spectrolite-frontmatter-depref"
              placeholder="npm:^1.0.0"
              value={row.ref}
              aria-label="Package reference"
              onChange={(event) => setRow(row.id, (r) => ({ ...r, ref: event.target.value }))}
            />
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              aria-label="Remove package"
              onClick={() => removeRow(row.id)}
            >
              <Cross2Icon />
            </IconButton>
          </Flex>
        ))}
        <Box>
          <Button size="1" variant="ghost" color="gray" onClick={addRow}>
            <PlusIcon /> Add package
          </Button>
        </Box>
      </Flex>
    </Box>
  );
}
