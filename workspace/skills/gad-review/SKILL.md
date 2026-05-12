---
name: gad-review
description: >-
  Use this skill when reviewing changes, planning changes, or asking whether
  an edit is justified by user intent. Treat gad SQL queries as graph expansion
  operators and trace artifacts back to direct user statements.
---

# gad Review

You are performing an agenda search over NatStack's tracked context graph.
Query gad through the runtime service:

```ts
import { gad } from "@workspace/runtime";
const { rows } = await gad.query("SELECT ... WHERE id = ?", [id]);
```

The review question is:

> Does this artifact trace back to a statement the user actually made, and does
> anything in scope contradict any user statement?

Rows in `conversation_turns` where `role = 'user'` are the highest authority.
Code, plans, semantic chunks, tool-call summaries, and agent claims are
derivations. Follow derivation chains until they bottom out in user words, or
until they dangle in unsanctioned inference.

## Prerequisites

For each session in scope, verify turns and linked tool calls:

```sql
SELECT s.id, s.source,
  (SELECT COUNT(*) FROM conversation_turns WHERE session_id = s.id) AS turns,
  (SELECT COUNT(*) FROM tool_calls WHERE session_id = s.id) AS calls,
  (SELECT COUNT(turn_id) FROM tool_calls WHERE session_id = s.id) AS calls_linked
FROM sessions s
WHERE s.id = ?;
```

If `turns = 0`, the conversation was not captured. If `calls_linked < calls`,
the tool-to-turn chain is incomplete. Report that the provenance chain is
partial before drawing conclusions.

## Starting Frontier

Choose the initial nodes from the user's prompt:

- Session id or latest session: start from mutations in that session.
- File list: start from recent mutations and versions for those files.
- Intended change with no mutation yet: start from the current user turn and
  the files you expect to touch.
- Branch question: start from `branches`, `branch_files`, and any fork metadata.

## Expansion Operators

Use only the expansions that answer the current review question.

### From A Mutation

```sql
SELECT tc.id, tc.tool_name, tc.turn_id, tc.session_id, tc.started_at
FROM tool_calls tc
WHERE tc.id = ?;
```

```sql
SELECT ct.id, ct.turn_index, ct.role, ct.content
FROM conversation_turns ct
WHERE ct.id = (
  SELECT turn_id FROM tool_calls WHERE id = ?
);
```

```sql
SELECT mutation_type, before_hash, after_hash, old_string, new_string, description
FROM tool_call_mutations
WHERE tool_call_id = ?;
```

```sql
SELECT tc.id, tc.tool_name, tcr.file_path, tcr.read_type,
       tcr.content_hash, tcr.start_line, tcr.end_line
FROM tool_call_reads tcr
JOIN tool_calls tc ON tcr.tool_call_id = tc.id
WHERE tc.session_id = ? AND tc.id < ?
ORDER BY tc.id DESC
LIMIT 50;
```

### From A Turn

```sql
SELECT id, turn_index, role, SUBSTR(content, 1, 600) AS preview
FROM conversation_turns
WHERE session_id = ? AND turn_index < ?
ORDER BY turn_index DESC
LIMIT 20;
```

```sql
SELECT id, turn_index, role, SUBSTR(content, 1, 600) AS preview
FROM conversation_turns
WHERE session_id = ? AND turn_index > ?
ORDER BY turn_index
LIMIT 20;
```

```sql
SELECT id, tool_name, is_mutation, started_at, completed_at
FROM tool_calls
WHERE turn_id = ?
ORDER BY id;
```

```sql
SELECT sc.content_hash, sc.topic_label, sc.content
FROM semantic_chunks sc
JOIN semantic_chunk_mentions scm ON sc.content_hash = scm.chunk_hash
WHERE scm.source_turn_id = ?;
```

### From A File

```sql
SELECT tcm.mutation_type, tc.id AS tool_call_id, tc.turn_id, tc.session_id,
       tc.started_at, SUBSTR(tcm.old_string, 1, 200) AS old_preview,
       SUBSTR(tcm.new_string, 1, 200) AS new_preview
FROM tool_call_mutations tcm
JOIN tool_calls tc ON tcm.tool_call_id = tc.id
WHERE tcm.file_path = ?
ORDER BY tc.started_at DESC
LIMIT 20;
```

```sql
SELECT id, content_hash, branch_id, session_id, tool_call_id, recorded_at
FROM file_versions
WHERE path = ?
ORDER BY recorded_at DESC
LIMIT 30;
```

```sql
SELECT DISTINCT fv.path
FROM semantic_relations sr1
JOIN semantic_relations sr2 ON sr1.chunk_hash = sr2.chunk_hash
  AND sr1.target_hash != sr2.target_hash
JOIN file_versions fv ON sr2.target_hash = fv.content_hash
WHERE sr1.target_type = 'blob'
  AND sr2.target_type = 'blob'
  AND sr1.target_hash IN (SELECT content_hash FROM file_versions WHERE path = ?)
  AND fv.path != ?;
```

### From A Branch

```sql
SELECT id, name, parent_branch_id, forked_from_session_id,
       forked_from_turn_id, forked_from_message_index, created_at, created_by
FROM branches
WHERE id = ?;
```

```sql
SELECT path, current_hash, is_deleted, updated_at
FROM branch_files
WHERE branch_id = ?
ORDER BY path;
```

```sql
SELECT id, parent_snapshot_id, session_id, turn_id, summary, created_at
FROM branch_snapshots
WHERE branch_id = ?
ORDER BY created_at DESC;
```

## Judgment Rules

- Prefer direct user turns over summaries and agent-authored plans.
- Treat semantic chunks as signposts, not as authority.
- Treat newer user turns as potential supersedence of older intent.
- A mutation is justified only when its purpose is supported by a user turn or
  by a chain of actions that clearly responds to one.
- If provenance is incomplete, state the gap instead of overclaiming.

## SQL Writes

Review usually reads only. If cleanup or annotation requires SQL writes, call
`gad.rawSql(...)`. Panels and workers will trigger a user approval prompt for
non-read-only SQL, so include narrow, auditable statements.
