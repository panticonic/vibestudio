/**
 * Global `JSX` namespace shim.
 *
 * React 19's `@types/react` no longer publishes a global `JSX` namespace (it
 * lives under `React.JSX`). A couple of the (frozen) editor modules return the
 * bare `JSX.Element`, so we re-expose the React JSX namespace globally for the
 * panel's type-check. Type-only; no runtime effect.
 */

import type * as React from "react";

declare global {
  namespace JSX {
    type Element = React.JSX.Element;
    type ElementClass = React.JSX.ElementClass;
    type ElementAttributesProperty = React.JSX.ElementAttributesProperty;
    type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute;
    type IntrinsicElements = React.JSX.IntrinsicElements;
    type IntrinsicAttributes = React.JSX.IntrinsicAttributes;
    type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>;
    type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
  }
}

export {};
