---
name: gad-review
description: Review code provenance using NatStack's clean Pi entry DAG, GAD event log, worktree state graph, file mutation projections, and blame hunks.
---

# GAD Review

Use the clean Pi/GAD architecture:

- Conversation facts: `pi_session_entries`, `pi_message_blocks`, `pi_tool_calls`.
- Sidecar audit: `gad_events`.
- Worktree provenance: `gad_file_mutations`, `gad_file_observations`, `gad_state_transitions`, `gad_file_change_hunks`.
- Branch heads: `pi_branches`.

Core queries:

```sql
SELECT branch_id, head_entry_id, head_state_hash, updated_at
FROM pi_branches
ORDER BY updated_at DESC;
```

```sql
SELECT entry_id, parent_entry_id, entry_type, role, entry_hash,
       pre_state_hash, post_state_hash, introduced_at
FROM pi_session_entries
ORDER BY introduced_at;
```

```sql
SELECT m.*, h.*
FROM gad_file_mutations m
LEFT JOIN gad_file_change_hunks h ON h.mutation_id = m.mutation_id
WHERE m.tool_call_id = ?
ORDER BY m.created_at, h.id;
```

```sql
SELECT st.*, e.kind, e.anchor_kind, e.anchor_id, e.payload_json
FROM gad_state_transitions st
JOIN gad_events e ON e.event_id = st.event_id
WHERE st.output_state_hash = ?
ORDER BY e.event_seq DESC;
```

Do not use legacy trajectory tables or trajectory terminology. They are not part
of the schema.
