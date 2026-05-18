---
name: gad-context
description: Query NatStack's clean Pi entry DAG and GAD sidecar event model for conversation context, runtime events, worktree states, file provenance, and semantic facts.
---

# GAD Context

Use the `gad` runtime namespace. The storage model is intentionally split:

- Pi context lives in `pi_branches`, `pi_session_entries`, `pi_message_blocks`, and `pi_tool_calls`.
- Runtime/world/semantic sidecars live in `gad_events` plus typed projection tables.
- Worktree state lives in `gad_worktree_states`, manifest tables, file versions, state transitions, mutations, observations, and hunks.

Do not query or reference legacy trajectory tables. They do not exist in the clean schema.

Useful APIs:

- `gad.getPiBranchHead({ branchId })`
- `gad.getBranchPath({ branchId, raw: true })`
- `gad.findEntries({ branchId, entryType })`
- `gad.listGadEvents({ anchorKind, anchorId, kind, limit })`
- `gad.listGadBranchFiles({ branchId })`
- `gad.diffGadStates({ leftStateHash, rightStateHash })`
- `gad.readGadFileAtState({ stateHash, path })`
- `gad.getGadStateProducer({ stateHash })`
- `gad.blameGadFileSnippet({ stateHash, path })`

For SQL reads, prefer:

```sql
SELECT branch_id, head_entry_id, head_entry_hash, head_state_hash, updated_at
FROM pi_branches
ORDER BY updated_at DESC;
```

```sql
SELECT event_seq, event_id, event_hash, prev_event_hash, kind,
       anchor_kind, anchor_id, created_at
FROM gad_events
ORDER BY event_seq DESC
LIMIT 100;
```
