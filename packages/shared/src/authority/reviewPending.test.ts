import { describe, expect, it } from "vitest";

import {
  isAuthorityPending,
  isReviewPending,
  pendingAuthorityNotice,
  pendingReviewNotice,
} from "./reviewPending.js";

/** The shape the dispatcher throws in-process. */
function accessError(): Record<string, unknown> {
  return {
    code: "EREVIEWPENDING",
    errorData: {
      authorityFailure: {
        reasonCode: "review-pending",
        reason: "Waiting for you to finish reviewing what's in your workspace.",
        remediation: {
          kind: "resolve-open-review",
          review: { approvalId: "workspace-creation-review", title: "what's in your workspace" },
        },
      },
    },
  };
}

describe("pendingReviewNotice", () => {
  it("reads the open review a thrown access error names", () => {
    expect(pendingReviewNotice(accessError())).toEqual({
      approvalId: "workspace-creation-review",
      title: "what's in your workspace",
      message: "Waiting for you to finish reviewing what's in your workspace.",
    });
  });

  it("reads it through the envelopes an RPC hop wraps it in", () => {
    // The same outcome arrives in-process as a thrown ServiceAccessError and
    // across the wire as whatever the client reconstructed. Both carry the code
    // and the payload; neither guarantees they sit at the same depth.
    const wrapped = { cause: { data: accessError() } };
    expect(pendingReviewNotice(wrapped)?.approvalId).toBe("workspace-creation-review");
  });

  it("is null for an ordinary failure, so a surface can still show a real error", () => {
    expect(pendingReviewNotice(new Error("network unreachable"))).toBeNull();
    expect(pendingReviewNotice({ code: "EACCES", errorData: {} })).toBeNull();
    expect(pendingReviewNotice(undefined)).toBeNull();
  });

  it("reads the wire response's own field name", () => {
    // `errorCode` on `RpcResponseError`, `code` once the client reconstructs it.
    expect(isReviewPending({ errorCode: "EREVIEWPENDING" })).toBe(true);
    expect(
      pendingReviewNotice({ errorCode: "EREVIEWPENDING", errorData: accessError()["errorData"] })
        ?.title
    ).toBe("what's in your workspace");
  });

  it("reads the typed authority reason when an RPC hop drops the error code", () => {
    expect(pendingReviewNotice({ errorData: accessError()["errorData"] })).toMatchObject({
      approvalId: "workspace-creation-review",
      title: "what's in your workspace",
    });
  });

  it("recognizes the outcome even when the payload did not survive the hop", () => {
    // A surface that can only say "waiting on a review" is still telling the
    // truth; one that says "could not be loaded" next to a Retry is not.
    expect(isReviewPending({ code: "EREVIEWPENDING" })).toBe(true);
    expect(pendingReviewNotice({ code: "EREVIEWPENDING" })).toBeNull();
    expect(isReviewPending({ code: "EACCES" })).toBe(false);
  });

  it("does not loop on a self-referencing error envelope", () => {
    const cyclic: Record<string, unknown> = { code: "EREVIEWPENDING" };
    cyclic["cause"] = cyclic;
    expect(isReviewPending(cyclic)).toBe(true);
  });
});

describe("pendingAuthorityNotice", () => {
  it("reads an exact pending acquisition through an extension wrapper", () => {
    const wrapped = {
      cause: {
        code: "EACQUIRE",
        errorData: {
          acquisition: {
            acquisitionId: "acq:templates-catalog",
            renderedAction: "read responses from github.com",
            pending: true,
          },
        },
      },
    };
    expect(pendingAuthorityNotice(wrapped)).toEqual({
      kind: "acquisition",
      approvalId: "acq:templates-catalog",
      title: "read responses from github.com",
      message: "Your approval is needed to read responses from github.com.",
    });
    expect(isAuthorityPending(wrapped)).toBe(true);
  });

  it("routes an acquisition joining an open review to that review's original decision", () => {
    const error = {
      cause: {
        errorCode: "EACQUIRE",
        errorData: {
          acquisition: {
            acquisitionId: "acq:waiting-on-welcome",
            renderedAction: "use the selected model",
            pending: true,
            existingReview: {
              approvalId: "welcome:personal",
              title: "Welcome — here's what's in your workspace",
            },
          },
        },
      },
    };
    expect(pendingAuthorityNotice(error)).toEqual({
      kind: "review",
      approvalId: "welcome:personal",
      title: "Welcome — here's what's in your workspace",
      message: "Waiting for you to finish reviewing Welcome — here's what's in your workspace.",
    });
    expect(isAuthorityPending(error)).toBe(true);
    expect(isReviewPending(error)).toBe(true);
    expect(pendingReviewNotice(error)?.approvalId).toBe("welcome:personal");
    expect(pendingAuthorityNotice({ data: error.cause.errorData })?.approvalId).toBe(
      "welcome:personal"
    );
  });

  it("does not link a completed joined review or malformed review reference to an acquisition card", () => {
    const acquisition = {
      acquisitionId: "acq:waiting-on-welcome",
      renderedAction: "use the selected model",
      pending: true,
      existingReview: { approvalId: "welcome:personal", title: "Welcome" },
    };
    expect(
      pendingAuthorityNotice({
        code: "EACQUIRE",
        data: { acquisition: { ...acquisition, pending: false } },
      })
    ).toBeNull();
    expect(
      pendingAuthorityNotice({
        code: "EACQUIRE",
        data: { acquisition: { ...acquisition, existingReview: { title: "Welcome" } } },
      })
    ).toBeNull();
    expect(
      isAuthorityPending({
        code: "EACQUIRE",
        data: { acquisition: { ...acquisition, existingReview: { title: "Welcome" } } },
      })
    ).toBe(false);
  });

  it("does not present a completed or malformed acquisition", () => {
    expect(
      pendingAuthorityNotice({
        code: "EACQUIRE",
        errorData: {
          acquisition: {
            acquisitionId: "acq:done",
            renderedAction: "read responses from github.com",
            pending: false,
          },
        },
      })
    ).toBeNull();
    expect(pendingAuthorityNotice({ code: "EACQUIRE", errorData: {} })).toBeNull();
  });
});
