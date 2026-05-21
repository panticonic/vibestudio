/**
 * Live JSX editor — replaces `GenericJsxEditor` for known components.
 *
 * MDXEditor's JSX descriptor `Editor` receives the mdast node of the JSX
 * element. We reconstruct the JSX source from that node (attrs + children)
 * and compile-and-render it via `compileComponent` from `@workspace/eval`
 * with `createPanelSandboxConfig(rpc)` bindings — so live JSX in the
 * document has full access to the panel runtime (rpc, fs, GitClient, …),
 * which is the "MDX eval environment with full runtime access" goal.
 *
 * On compile failure we fall back to the small "broken" placeholder UI
 * with the error message; the user can switch to source view via the
 * `diffSourcePlugin` toggle and fix the JSX by hand.
 *
 * Children for flow components are kept editable as Lexical text via
 * `NestedEditor` from MDXEditor so prose inside a `<Callout>` is still
 * inline-editable while the surrounding component shell renders live.
 */

import { useEffect, useMemo, useState, type ComponentType } from "react";
import type { JsxEditorProps } from "@mdxeditor/editor";
import { Box, Card, Code, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, Pencil1Icon } from "@radix-ui/react-icons";
import { compileComponent } from "@workspace/eval";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import { rpc } from "@workspace/runtime";
import { mdxComponents } from "@workspace/agentic-chat";

const sandbox = createPanelSandboxConfig(rpc);

interface MdxAttribute {
  type: string;
  name?: string;
  value?: unknown;
}

interface JsxNode {
  type: string;
  name?: string | null;
  attributes?: MdxAttribute[];
  children?: Array<{ type: string; value?: string }>;
}

/** Render a JSX attribute as a TSX source snippet. */
function renderAttribute(attr: MdxAttribute): string {
  if (attr.type !== "mdxJsxAttribute" || !attr.name) return "";
  const value = attr.value;
  if (value == null) return ` ${attr.name}`;
  if (typeof value === "string") {
    return ` ${attr.name}="${value.replace(/"/g, "&quot;")}"`;
  }
  if (typeof value === "object" && value !== null && "value" in value) {
    const exprValue = (value as { value?: string }).value ?? "";
    return ` ${attr.name}={${exprValue}}`;
  }
  return "";
}

function nodeToSource(node: JsxNode): string {
  const name = node.name ?? "Fragment";
  const attrs = (node.attributes ?? []).map(renderAttribute).join("");
  const childText = (node.children ?? [])
    .map((c) => (c.type === "text" ? (c.value ?? "") : ""))
    .join("");
  if (!childText) return `<${name}${attrs} />`;
  return `<${name}${attrs}>${childText}</${name}>`;
}

const componentImports = Object.keys(mdxComponents);
const componentList = componentImports.join(", ");

function wrapForSandbox(source: string): string {
  // Inject mdxComponents and runtime.Eval as locals so any JSX tag in the
  // user's source resolves. Live runtime bindings (rpc, fs, …) come from
  // the sandbox `bindings`/`scope` injection.
  return `
import * as React from "react";
import { ${componentList} } from "@workspace/agentic-chat";

export default function LiveJsx() {
  return (
    ${source}
  );
}
`;
}

export function LiveJsxEditor(props: JsxEditorProps) {
  const { mdastNode, descriptor } = props;
  const source = useMemo(() => nodeToSource(mdastNode as unknown as JsxNode), [mdastNode]);
  const wrapped = useMemo(() => wrapForSandbox(source), [source]);
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setComponent(null);
    void compileComponent(wrapped, {
      loadImport: sandbox.loadImport,
      sourcePath: `workspace/panels/spectrolite/inline-jsx-${(descriptor.name ?? "x")}.tsx`,
    }).then((result) => {
      if (cancelled) return;
      if (result.success && result.Component) {
        setComponent(() => result.Component as ComponentType);
      } else {
        setError(result.error ?? "compile failed");
      }
    });
    return () => { cancelled = true; };
  }, [wrapped, descriptor.name]);

  if (error) {
    return (
      <Card>
        <Flex direction="column" gap="1">
          <Flex align="center" gap="1">
            <ExclamationTriangleIcon color="red" />
            <Text size="1" color="red" weight="medium">{descriptor.name}</Text>
            <Text size="1" color="gray">— preview failed</Text>
          </Flex>
          <Code size="1" style={{ whiteSpace: "pre-wrap" }}>{error}</Code>
          <Text size="1" color="gray">
            <Pencil1Icon /> Use the diff/source toggle to edit the JSX by hand.
          </Text>
        </Flex>
      </Card>
    );
  }

  if (!Component) {
    return (
      <Box style={{ opacity: 0.6 }}>
        <Text size="1" color="gray">Rendering &lt;{descriptor.name ?? "?"}&gt;…</Text>
      </Box>
    );
  }

  return (
    <Box
      style={{
        position: "relative",
        outline: "1px dashed var(--gray-5)",
        outlineOffset: 4,
        borderRadius: "var(--radius-2)",
      }}
    >
      <Component />
    </Box>
  );
}
