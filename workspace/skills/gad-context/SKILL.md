---
name: gad-context
description: >-
  Use this skill when the user asks about change history, provenance, why code
  changed, assumptions behind a change, branch context, tracked edits, or gad.
  Query the NatStack gad service for sessions, turns, tool calls, reads,
  mutations, file versions, branches, plans, and semantic chunks.
---

# gad Context

gad is NatStack's workspace provenance database. It is exposed through the
runtime `gad` service, backed by the `gad-store` workspace durable object and
the workspace blobstore.

Use `gad.query(sql, bindings)` for reads. Panels and workers may also call
`gad.rawSql(sql, bindings)` for arbitrary SQL. Non-read-only raw SQL is gated
by the userland approval UI for the calling panel or worker.

```ts
import { gad } from "@workspace/runtime";

const { rows } = await gad.query(
  "SELECT id, source, started_at FROM sessions ORDER BY started_at DESC LIMIT ?",
  [10],
);
```

## Common Queries

### Status

```ts
await gad.status();
```

### Recent Sessions

```sql
SELECT id, source, branch_id, channel_id, context_id, started_at, ended_at
FROM sessions
ORDER BY started_at DESC
LIMIT 20;
```

### Conversation Turns For A Session

```sql
SELECT id, turn_index, role, SUBSTR(content, 1, 800) AS preview, timestamp
FROM conversation_turns
WHERE session_id = ?
ORDER BY turn_index;
```

### Tool Calls In A Session

```sql
SELECT id, tool_name, turn_id, is_mutation, branch_id, started_at, completed_at,
       SUBSTR(result_summary, 1, 300) AS result_preview
FROM tool_calls
WHERE session_id = ?
ORDER BY id;
```

### Mutations To A File

```sql
SELECT tcm.mutation_type, tcm.before_hash, tcm.after_hash,
       SUBSTR(tcm.old_string, 1, 200) AS old_preview,
       SUBSTR(tcm.new_string, 1, 200) AS new_preview,
       tc.id AS tool_call_id, tc.session_id, tc.turn_id, tc.started_at
FROM tool_call_mutations tcm
JOIN tool_calls tc ON tcm.tool_call_id = tc.id
WHERE tcm.file_path = ?
ORDER BY tc.started_at DESC;
```

### Reads Before The Last Mutation To A File

```sql
SELECT tcr.file_path, tcr.read_type, tcr.content_hash, tcr.start_line, tcr.end_line,
       tc.id AS tool_call_id, tc.tool_name, tc.started_at
FROM tool_call_reads tcr
JOIN tool_calls tc ON tcr.tool_call_id = tc.id
WHERE tc.session_id = (
    SELECT tc2.session_id
    FROM tool_calls tc2
    JOIN tool_call_mutations tcm ON tc2.id = tcm.tool_call_id
    WHERE tcm.file_path = ?
    ORDER BY tc2.started_at DESC
    LIMIT 1
  )
  AND tc.id < (
    SELECT tc2.id
    FROM tool_calls tc2
    JOIN tool_call_mutations tcm ON tc2.id = tcm.tool_call_id
    WHERE tcm.file_path = ?
    ORDER BY tc2.id DESC
    LIMIT 1
  )
ORDER BY tc.id;
```

### File Versions

```sql
SELECT path, content_hash, branch_id, git_branch, git_commit,
       session_id, tool_call_id, recorded_at
FROM file_versions
WHERE path = ?
ORDER BY recorded_at DESC;
```

### Branches

```sql
SELECT id, name, parent_branch_id, forked_from_session_id,
       forked_from_turn_id, forked_from_message_index, created_at, archived_at
FROM branches
ORDER BY created_at DESC;
```

### Files In A Branch

```sql
SELECT path, current_hash, is_deleted, updated_at
FROM branch_files
WHERE branch_id = ?
ORDER BY path;
```

### Semantic Signposts For A File

```sql
SELECT DISTINCT sc.content_hash, sc.topic_label, sc.content
FROM semantic_chunks sc
JOIN semantic_relations sr ON sc.content_hash = sr.chunk_hash
WHERE sr.target_type = 'blob'
  AND sr.target_hash IN (
    SELECT content_hash FROM file_versions WHERE path = ?
  );
```

### Turns Mentioning A Semantic Signpost

```sql
SELECT scm.source_session_id, scm.source_turn_id, scm.attribution,
       ct.role, SUBSTR(ct.content, 1, 600) AS preview
FROM semantic_chunk_mentions scm
LEFT JOIN conversation_turns ct ON ct.id = scm.source_turn_id
WHERE scm.chunk_hash = ?;
```

## Reading Blobs

Blob contents live in the workspace blobstore. Use `blobstore.getText` through
RPC when you need the text for a `content_hash`.

```ts
const text = await rpc.call<string | null>("main", "blobstore.getText", hash);
```

## Writing SQL

Use writes sparingly and explain the intent in the approval request. The runtime
will ask the user to approve non-read-only SQL for the caller:

```ts
await gad.rawSql(
  "UPDATE branches SET archived_at = datetime('now') WHERE id = ?",
  [branchId],
);
```
