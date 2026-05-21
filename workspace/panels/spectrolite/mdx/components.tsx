/**
 * Spectrolite-specific MDX components on top of `@workspace/agentic-chat`'s
 * `mdxComponents` set.
 *
 * Currently adds:
 *   - `<WikiLink target="Page">label</WikiLink>` — clickable Obsidian-style
 *     internal link. Resolution is done by the parent via a context value
 *     so the component itself stays purely declarative.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import { Link } from "@radix-ui/themes";
import { mdxComponents as chatMdxComponents } from "@workspace/agentic-chat";

export interface WikilinkContextValue {
  /** Resolve a wikilink target (e.g. "My Note") to a workspace-relative path. */
  resolve: (target: string) => string | null;
  /** Open a workspace-relative path in the editor. */
  open: (path: string) => void;
  /** Open the target if it exists, otherwise create a stub MDX file and open it. */
  openOrCreate: (target: string) => void | Promise<void>;
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
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    void ctx?.openOrCreate(target);
  };
  if (!resolved) {
    return (
      <Link
        href="#"
        onClick={onClick}
        style={{ color: "var(--gray-10)", textDecoration: "underline dashed" }}
        title={`Click to create [[${target}]]`}
      >
        {label}
      </Link>
    );
  }
  return (
    <Link href="#" onClick={onClick} title={resolved}>
      {label}
    </Link>
  );
}

export const spectroliteMdxComponents: Record<string, unknown> = {
  ...(chatMdxComponents as Record<string, unknown>),
  WikiLink,
};
