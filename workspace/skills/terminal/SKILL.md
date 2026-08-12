---
name: terminal
description: Run bounded local commands from an agent without a direct terminal tool through the installed shell extension; use literal argv by default and shell text only for intentional shell syntax.
---

# Terminal commands

The public agent/runtime path is the installed `shell` extension. For a normal
command, use argv mode so arguments are passed literally:

```ts
import { extensions } from "@workspace/runtime";

const result = await extensions.invoke("shell", "exec", [
  {
    intent: {
      kind: "argv",
      executable: "/usr/bin/printf",
      args: ["hello"],
    },
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  },
]);
```

Run that code with `eval`; for a multi-file workflow, put the code in a
context-relative file and eval the file. The result reports `exitCode`,
`stdout`, `stderr`, and `durationMs`.

Use shell-text mode only when pipes, redirections, globbing, or other shell
syntax are part of the user's request. Do not turn an argv command into shell
text for convenience. Do not inspect the shell extension source to discover
its API: `docs_search`/`docs_open` and this skill are the public contract.

Permission is ordinary product behavior. Call the documented operation once;
if it needs approval, let the invocation suspend and resume through the normal
approval path. A structured denial is terminal unless its remediation names a
concrete state change.

Keep output bounded and report the command's exit status, relevant stdout or
stderr, and whether it timed out or was truncated.
