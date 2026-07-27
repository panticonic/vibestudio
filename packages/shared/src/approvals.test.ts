import { describe, expect, it } from "vitest";
import {
  USERLAND_APPROVAL_REVIEW_DETAILS_MAX_BYTES,
  USERLAND_APPROVAL_SEALED_DETAILS_MAX_BYTES,
  userlandApprovalRequestSchema,
  userlandApprovalSubjectIdSchema,
} from "./approvals.js";

const validRequest = {
  subject: { id: "team-x:foo", label: "Team X foo" },
  title: "Allow foo?",
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
  ],
};

describe("userland approval validation", () => {
  it("accepts default scoped prompts without custom options", () => {
    expect(
      userlandApprovalRequestSchema.parse({
        subject: { id: "team-x:foo", label: "Team X foo" },
        title: "Allow foo?",
      })
    ).toEqual({
      subject: { id: "team-x:foo", label: "Team X foo" },
      title: "Allow foo?",
    });
  });

  it("strips zero-width characters before reserved-prefix and duplicate checks", () => {
    expect(() => userlandApprovalSubjectIdSchema.parse("shell\u200B:foo")).toThrow(/reserved/);
    expect(() =>
      userlandApprovalRequestSchema.parse({
        ...validRequest,
        options: [
          { value: "allow", label: "Allow" },
          { value: "al\u200Blow", label: "Allow again" },
        ],
      })
    ).toThrow(/unique/);
  });

  it("accepts newlines in multi-line summary and detail values (markdown blocks)", () => {
    const parsed = userlandApprovalRequestSchema.parse({
      ...validRequest,
      summary: "Run this command:\n\n```sh\nls -la\n```",
      details: [{ label: "Command", value: "```sh\nls -la\n```", format: "markdown" }],
    });
    expect(parsed.summary).toContain("\n");
    expect(parsed.details?.[0]?.value).toContain("\n");
  });

  it("rejects non-newline control characters even in multi-line fields", () => {
    expect(() =>
      userlandApprovalRequestSchema.parse({ ...validRequest, summary: "bad\u0001summary" })
    ).toThrow(/control/);
    expect(() =>
      userlandApprovalRequestSchema.parse({ ...validRequest, summary: "bad\rsummary" })
    ).toThrow(/control/);
    expect(() =>
      userlandApprovalRequestSchema.parse({ ...validRequest, title: "multi\nline title" })
    ).toThrow(/control/);
  });

  it("rejects control characters, invalid identifiers, and reserved option values", () => {
    expect(() =>
      userlandApprovalRequestSchema.parse({ ...validRequest, title: "bad\u0001title" })
    ).toThrow(/control/);
    expect(() => userlandApprovalSubjectIdSchema.parse("bad subject")).toThrow(/invalid/);
    expect(() =>
      userlandApprovalRequestSchema.parse({
        ...validRequest,
        options: [{ value: "dismiss", label: "Dismiss" }],
      })
    ).toThrow(/reserved/);
  });

  it("returns sanitized strings for callers to enqueue and persist", () => {
    const parsed = userlandApprovalRequestSchema.parse({
      ...validRequest,
      subject: { id: "team\u200B-x:foo", label: "Team\u200B X" },
    });

    expect(parsed.subject).toEqual({ id: "team-x:foo", label: "Team X" });
  });

  it("accepts dangerous-action metadata and positive evidence", () => {
    expect(
      userlandApprovalRequestSchema.parse({
        subject: { id: "team-x:danger" },
        title: "Run privileged command",
        severity: "dangerous",
        defaultAction: "deny",
        positiveEvidence: [{ label: "Gate", value: "sudoers" }],
      })
    ).toMatchObject({
      severity: "dangerous",
      defaultAction: "deny",
      positiveEvidence: [{ label: "Gate", value: "sudoers" }],
    });
  });

  it("admits a complete large sealed detail but rejects content beyond the RPC frame budget", () => {
    expect(
      userlandApprovalRequestSchema.parse({
        ...validRequest,
        sealedDetails: [
          { label: "Complete execution plan", content: "x".repeat(2_000), format: "code" },
        ],
      }).sealedDetails?.[0]?.content
    ).toHaveLength(2_000);

    expect(() =>
      userlandApprovalRequestSchema.parse({
        ...validRequest,
        sealedDetails: [
          {
            label: "Complete execution plan",
            content: "x".repeat(USERLAND_APPROVAL_SEALED_DETAILS_MAX_BYTES + 1),
          },
        ],
      })
    ).toThrow(/reviewed immutable file or artifact/);
  });

  it("bounds review projections without preventing larger sealed-only invocation payloads", () => {
    const content = "x".repeat(USERLAND_APPROVAL_REVIEW_DETAILS_MAX_BYTES + 1);
    expect(() =>
      userlandApprovalRequestSchema.parse({
        ...validRequest,
        sealedDetails: [{ label: "Review", content, disclosure: "review" }],
      })
    ).toThrow(/too large for an interactive prompt/);

    expect(
      userlandApprovalRequestSchema.parse({
        ...validRequest,
        sealedDetails: [{ label: "Execution seal", content, disclosure: "sealed-only" }],
      }).sealedDetails?.[0]
    ).toMatchObject({ content, disclosure: "sealed-only" });
  });
});
