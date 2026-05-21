/**
 * Spectrolite-specific MDX components on top of `@workspace/agentic-chat`'s
 * `mdxComponents` set.
 *
 * Currently adds:
 *   - `<WikiLink target="Page">label</WikiLink>` — clickable Obsidian-style
 *     internal link. Resolution is done by the parent via a context value
 *     so the component itself stays purely declarative.
 */

import { createContext, useContext, type ReactNode } from "react";
import { Link, Text } from "@radix-ui/themes";
import { mdxComponents as chatMdxComponents } from "@workspace/agentic-chat";

export interface WikilinkContextValue {
  /** Resolve a wikilink target (e.g. "My Note") to a workspace-relative path. */
  resolve: (target: string) => string | null;
  /** Open a workspace-relative path in the editor. */
  open: (path: string) => void;
}

export const WikilinkContext = createContext<WikilinkContextValue | null>(null);

export interface WikiLinkProps {
  target: string;
  children?: ReactNode;
}

export function WikiLink({ target, children }: WikiLinkProps) {
  const ctx = useContext(WikilinkContext);
  const resolved = ctx?.resolve(target) ?? null;
  const label = children ?? target;
  if (!resolved) {
    return (
      <Text style={{ color: "var(--gray-9)", textDecoration: "underline dashed" }} title={`No file matches [[${target}]]`}>
        {label}
      </Text>
    );
  }
  return (
    <Link
      href="#"
      onClick={(e) => {
        e.preventDefault();
        ctx?.open(resolved);
      }}
    >
      {label}
    </Link>
  );
}

export const spectroliteMdxComponents: Record<string, unknown> = {
  ...(chatMdxComponents as Record<string, unknown>),
  WikiLink,
};
