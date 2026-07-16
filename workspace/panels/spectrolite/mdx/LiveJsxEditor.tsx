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
 * Each JSX node compiles in ISOLATION (local incremental render — a node
 * recompiles only when its own serialized source changes). There is no
 * whole-doc compile, so doc-level cross-node exports (a `<Counter/>` that
 * references an `export const Counter` declared elsewhere in the same doc)
 * are intentionally NOT in scope.
 *
 * On compile failure we surface a small error card pointing the user to
 * the diff/source toggle so they can edit the JSX by hand.
 */

import {
  Component as ReactComponent,
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

interface MdastJsxLike {
  type: string;
  name?: string | null;
}

/**
 * Build the wrapper source. Each JSX node is compiled in isolation (local
 * incremental render); doc-level cross-node exports are intentionally not in
 * scope (the whole-doc compile that bridged them was removed).
 */
function wrapForSandbox(source: string): string {
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
// doc's frontmatter without an import the sandbox can't resolve.
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
  const { mdastNode, descriptor, dependencies } = props;
  const tagName = (mdastNode as unknown as MdastJsxLike).name ?? descriptor.name ?? "Fragment";
  const source = useMemo(() => nodeToMdxSource(mdastNode), [mdastNode]);
  const wrapped = useMemo(() => wrapForSandbox(source), [source]);
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      sourcePath: `workspace/panels/spectrolite/inline-jsx-${tagName === "*" ? "wild" : tagName}.tsx`,
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

  if (error) {
    return <LiveJsxErrorCard tagName={tagName} error={error} />;
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
    </Box>
  );
}

function LiveJsxErrorCard({ tagName, error }: { tagName: string; error: string }) {
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
        <Text size="1" color="gray">
          <Pencil1Icon /> Use the diff/source toggle to edit the JSX by hand.
        </Text>
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
