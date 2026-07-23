# Host approval copy

Host-authored approval wording has two editing surfaces:

1. [`hostApprovalCopy.ts`](./hostApprovalCopy.ts) contains shared prompt chrome,
   titles, summaries, warnings, decision labels, unit-version review wording,
   push-notification actions, semantic capability names, and permission-group
   descriptions. Desktop, mobile, terminal-derived summaries, and push prompts
   consume this catalog.
2. [`authority/hostCapabilityPresentations.ts`](./authority/hostCapabilityPresentations.ts)
   contains the exhaustive human name, action, description, and group for every
   promptable static host service method. Its type check intentionally fails when
   a newly gated host method has no reviewed copy.

Do not add workspace/userland approval wording to either catalog. Userland
providers supply their own attributed title, summary, warning, and choices at
runtime. Dynamic workspace-service declarations likewise provide their service
name and description from the exact active workspace build.

## Style contract

- `title`: short noun/verb headline, understandable without an API name.
- `action`: lower-case verb phrase completing “Allow _requester_ to …?”
- `description`: one concrete sentence describing the effect, not the transport.
- Use `{requesterKind}` in static host-method descriptions. The renderer replaces it
  with the verified kind (`this app`, `this panel`, `this worker`, or
  `this extension`). Do not write “this unit.”
- The requester display name (for example, `Agentic Chat`) belongs in the trusted
  card header, next to its kind. Do not interpolate mutable workspace titles into
  capability descriptions and do not substitute hashes or internal IDs for a
  display name. Revision hashes, trust keys, and authority chains belong only in
  expandable request details.
- Never expose RPC/service method names such as `resolveService`, `resolveProfile`,
  or `getClientConfigStatus` as prompt copy.
- Say what data or device effect is involved. Avoid “access,” “manage,” or “use”
  when a more concrete verb is available.
- If an operation is open discovery/readiness plumbing, it should not prompt at
  all; changing its wording is not a substitute for correcting its authority tier.

Run the focused copy and surface checks after edits:

```sh
pnpm vitest run packages/shared/src/approvalCopy.test.ts packages/shared/src/authorityPresentation.test.ts workspace/apps/shell/components/ApprovalCard.test.tsx
pnpm --dir apps/mobile exec jest --runInBand --runTestsByPath ../../workspace/apps/mobile/src/components/ApprovalSheet.test.tsx
```
