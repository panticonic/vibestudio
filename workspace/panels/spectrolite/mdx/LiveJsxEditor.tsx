/**
 * Live JSX editor — replaces `GenericJsxEditor` for every JSX descriptor.
 *
 * MDXEditor's JSX descriptor `Editor` receives the mdast node of the JSX
 * element. We serialize the full subtree (including nested JSX, paragraphs,
 * lists, etc.) back to MDX source via `mdast-util-to-markdown` +
 * `mdast-util-mdx-jsx`, then compile-and-render it via `compileComponent`
 * with `createPanelSandboxConfig(rpc)` bindings — so live JSX in the
 * document has full access to the panel runtime (rpc, fs, vcs, ...),
 * which is the "MDX eval environment with full runtime access" goal.
 *
 * Works for the wildcard `name: "*"` descriptor too: we read the actual
 * tag name from `mdastNode.name` rather than `descriptor.name`.
 *
 * The `runtime` namespace + a few hooks are pulled in via globalThis
 * backdoors set by `DocumentEditor`:
 *
 *   - `globalThis.__spectroliteUseDocState__` — useDocState hook
 *   - `globalThis.__spectroliteRuntime__`     — `runtime.Eval`, etc.
 *
 * Each JSX node compiles incrementally, while preserved top-level MDX module
 * declarations are injected into its module scope. Thus `<Counter/>` can use
 * an `export const Counter` authored elsewhere in the same document without
 * replacing the whole rich editor on every keystroke.
 *
 * Every rendered node has a source affordance; compile failures keep the same
 * source editor available instead of trapping the user in a broken preview.
 */

import {
  Component as ReactComponent,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { JsxEditorProps } from "@workspace/mdx-editor-core";
import { Box, Card, Code, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, Pencil1Icon } from "@radix-ui/react-icons";
import { compileComponent } from "@workspace/eval";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import { rpc } from "@workspace/runtime";
import { mdxComponents } from "@workspace/agentic-chat";
import { nodeToMdxSource } from "./mdastSerialize";
import { WikiLink as SpectroliteWikiLink } from "./components";
import { fromMarkdown } from "mdast-util-from-markdown";
import { assembleMdxConfig } from "@workspace/mdx-editor-core";
import type { MdastJsx } from "@workspace/mdx-editor-core";
import { wikilinkValue } from "./wikilink";

// Inline MDX is compiled as an isolated module. Publish the host component so
// the compiled module renders the same context-aware wikilink as the rest of
// Spectrolite instead of a preview-only imitation.
(
  globalThis as typeof globalThis & {
    __spectroliteWikiLinkComponent__?: typeof SpectroliteWikiLink;
  }
).__spectroliteWikiLinkComponent__ = SpectroliteWikiLink;

const sandbox = createPanelSandboxConfig(rpc);
const BASE_LIVE_JSX_IMPORTS = { "@workspace/agentic-chat": "latest" } as const;

// PascalCase component names exported by @workspace/agentic-chat that we
// inject unconditionally into the live-compile wrapper. The set mirrors
// the chat panel's MDX component surface so docs are portable.
const importedNames = Object.keys(mdxComponents as Record<string, unknown>).filter((n) =>
  /^[A-Z]/.test(n)
);
const importList = importedNames.join(", ");

/** Preserved top-level MDX module declarations visible to each live JSX node. */
export const DocModuleSourceContext = createContext("");

const sourceConfig = assembleMdxConfig();

interface MdastJsxLike {
  type: string;
  name?: string | null;
}

/**
 * Build an incremental wrapper with the document's preserved module scope.
 */
function wrapForSandbox(source: string, moduleSource: string): string {
  return `
import * as React from "react";
import { mdxComponents } from "@workspace/agentic-chat";

// @workspace/agentic-chat exposes the MDX surface as a runtime map, not as
// individual named exports. Destructure from that map so namespace-style
// components such as <Callout.Icon> and <Icons.InfoCircledIcon> keep their
// static properties intact in sandboxed inline JSX.
const { ${importList} } = mdxComponents;

const WikiLink = globalThis.__spectroliteWikiLinkComponent__ ||
  function WikiLinkFallback({ target, children }) {
    return <span data-wikilink={target} className="wikilink">{children ?? target}</span>;
  };

function ActionButton({ children, message, variant = "soft", size = "1" }) {
  return (
    <Button size={size} variant={variant} disabled title="ActionButton is preview-only in Spectrolite documents">
      {children ?? message}
    </Button>
  );
}

// useDocState — Spectrolite publishes the hook on globalThis (see
// DocumentEditor) so sandboxed components can persist state into the
// panel-local view state without an import the sandbox can't resolve.
const useDocState = (globalThis.__spectroliteUseDocState__) ||
  function useDocStateFallback(_key, initial) {
    return React.useState(initial);
  };

// Responsive hooks — same as @workspace/react's exports. Available so
// MDX-defined inline components can render mobile-aware UI without
// importing anything the sandbox can't resolve.
const useIsMobile = (globalThis.__spectroliteUseIsMobile__) || (() => false);
const useTouchDevice = (globalThis.__spectroliteUseTouchDevice__) || (() => false);
const useViewportHeight = (globalThis.__spectroliteUseViewportHeight__) ||
  (() => (typeof window === "undefined" ? 800 : window.innerHeight));

// runtime — the panel's MDX runtime namespace (Eval, useDocState,
// useIsMobile, …), shared with the whole-doc compile so <runtime.Eval/>
// works the same way both inline and at the doc level.
const runtime = globalThis.__spectroliteRuntime__ ||
  { useDocState, useIsMobile, useTouchDevice, useViewportHeight };

${moduleSource}

export default function LiveJsx() {
  return (<>
    ${source}
  </>);
}
`;
}

export interface LiveJsxEditorOwnProps {
  /** Frontmatter-declared dependencies, merged into compileComponent imports. */
  dependencies?: Record<string, string>;
}

export function LiveJsxEditor(props: JsxEditorProps & LiveJsxEditorOwnProps) {
  const { mdastNode, descriptor, dependencies, onChange } = props;
  const moduleSource = useContext(DocModuleSourceContext);
  const tagName = (mdastNode as unknown as MdastJsxLike).name ?? descriptor.name ?? "Fragment";
  const source = useMemo(() => nodeToMdxSource(mdastNode), [mdastNode]);
  const wrapped = useMemo(() => wrapForSandbox(source, moduleSource), [source, moduleSource]);
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const nativeWikilink = wikilinkValue(mdastNode);

  useEffect(() => {
    if (!editing) setDraft(source);
  }, [editing, source]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setComponent(null);
    if (!source.trim()) {
      return () => {
        cancelled = true;
      };
    }
    const compileImports = {
      ...BASE_LIVE_JSX_IMPORTS,
      ...(dependencies ?? {}),
    };
    void compileComponent(wrapped, {
      loadImport: sandbox.loadImport,
      sourcePath: `panels/spectrolite/inline-jsx-${tagName === "*" ? "wild" : tagName}.tsx`,
      imports: compileImports,
    }).then((result) => {
      if (cancelled) return;
      if (result.success && result.Component) {
        setComponent(() => result.Component as ComponentType);
      } else {
        setError(result.error ?? "compile failed");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [wrapped, tagName, source, dependencies]);

  const saveSource = () => {
    if (!onChange) return;
    try {
      const tree = fromMarkdown(draft, {
        extensions: sourceConfig.syntaxExtensions,
        mdastExtensions: sourceConfig.mdastExtensions,
      });
      const direct = tree.children[0];
      const candidate =
        direct?.type === "mdxJsxFlowElement" || direct?.type === "mdxJsxTextElement"
          ? direct
          : direct?.type === "paragraph" && direct.children.length === 1
            ? direct.children[0]
            : null;
      if (
        tree.children.length !== 1 ||
        !candidate ||
        (candidate.type !== "mdxJsxFlowElement" && candidate.type !== "mdxJsxTextElement")
      ) {
        throw new Error("Source must contain exactly one JSX element");
      }
      onChange(candidate as MdastJsx);
      setSourceError(null);
      setEditing(false);
    } catch (nextError) {
      setSourceError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  if (editing) {
    return (
      <Card className="spectrolite-jsx-source-editor">
        <Flex direction="column" gap="2">
          <textarea
            aria-label={`Edit ${tagName} source`}
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          {sourceError ? <Text size="1" color="red">{sourceError}</Text> : null}
          <Flex gap="2" justify="end">
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" onClick={saveSource}>Apply source</button>
          </Flex>
        </Flex>
      </Card>
    );
  }

  if (nativeWikilink) {
    return (
      <Box className="spectrolite-jsx-block" style={{ position: "relative", display: "inline" }}>
        <SpectroliteWikiLink target={nativeWikilink.target}>
          {nativeWikilink.label}
        </SpectroliteWikiLink>
        {onChange ? (
          <button
            type="button"
            className="spectrolite-jsx-edit-source"
            aria-label="Edit WikiLink source"
            onClick={() => setEditing(true)}
          >
            <Pencil1Icon />
          </button>
        ) : null}
      </Box>
    );
  }

  if (error) {
    return (
      <LiveJsxErrorCard
        tagName={tagName}
        error={error}
        onEdit={onChange ? () => setEditing(true) : undefined}
      />
    );
  }

  if (!Component) {
    return (
      <Box style={{ opacity: 0.6 }}>
        <Text size="1" color="gray">
          Rendering &lt;{tagName}&gt;…
        </Text>
      </Box>
    );
  }

  return (
    <Box
      className="spectrolite-jsx-block"
      style={{
        position: "relative",
        borderRadius: "var(--radius-2)",
      }}
    >
      <LiveJsxRuntimeBoundary tagName={tagName}>
        <Component />
      </LiveJsxRuntimeBoundary>
      {onChange ? (
        <button
          type="button"
          className="spectrolite-jsx-edit-source"
          aria-label={`Edit ${tagName} source`}
          onClick={() => setEditing(true)}
        >
          <Pencil1Icon />
        </button>
      ) : null}
    </Box>
  );
}

function LiveJsxErrorCard({
  tagName,
  error,
  onEdit,
}: {
  tagName: string;
  error: string;
  onEdit?: () => void;
}) {
  return (
    <Card data-testid="spectrolite-live-jsx-error">
      <Flex direction="column" gap="1">
        <Flex align="center" gap="1">
          <ExclamationTriangleIcon color="red" />
          <Text size="1" color="red" weight="medium">
            &lt;{tagName}&gt;
          </Text>
          <Text size="1" color="gray">
            — preview failed
          </Text>
        </Flex>
        <Code size="1" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </Code>
        {onEdit ? (
          <button type="button" onClick={onEdit}>
            <Pencil1Icon /> Edit JSX source
          </button>
        ) : null}
      </Flex>
    </Card>
  );
}

class LiveJsxRuntimeBoundary extends ReactComponent<
  { tagName: string; children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidUpdate(prevProps: { tagName: string; children: ReactNode }): void {
    if (prevProps.children !== this.props.children && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      return <LiveJsxErrorCard tagName={this.props.tagName} error={this.state.error} />;
    }
    return this.props.children;
  }
}
