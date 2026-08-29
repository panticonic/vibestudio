# `@vibestudio/browser-import-archive`

Runtime-neutral, deterministic parsing for browser exports selected through a trusted host's
native file picker. The package does not open files or ZIP archives: callers enumerate and bound
archive entries, then pass `{ name, bytes }` values here.

Use `inspectBrowserExport` to recognize available datasets without retaining imported values.
Use `parseSelectedBrowserExport` for an import so that password rows are decoded only when the
password category was explicitly selected. `recognizeBrowserExport` is a convenience for trusted
callers intentionally parsing every supported category.

The parser accepts Safari export bookmarks/history/passwords, Netscape bookmark HTML, Chrome and
Google Password Manager CSV, and stable Google Takeout Chrome bookmark/history representations.
All failures use fixed messages and entry indexes; record values and entry names are never copied
into errors.
