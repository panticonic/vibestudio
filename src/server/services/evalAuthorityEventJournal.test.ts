import { describe, expect, it, vi } from "vitest";
import { EvalAuthorityEventJournal, type EvalAuthorityEvent } from "./evalAuthorityEventJournal.js";

function event(
  kind: EvalAuthorityEvent["kind"],
  overrides: Partial<EvalAuthorityEvent> = {}
): EvalAuthorityEvent {
  return {
    objectKey: "owner",
    runId: "run-1",
    kind,
    payload: { kind },
    ...overrides,
  };
}

describe("EvalAuthorityEventJournal", () => {
  it("accepts a re-entrant observation without awaiting its EvalDO write", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.fn(() => pending);
    const journal = new EvalAuthorityEventJournal({ dispatch });

    journal.append(event("authority-requested"));

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    release();
    await journal.close();
  });

  it("preserves per-EvalDO event order without serializing independent EvalDOs", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatch = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const journal = new EvalAuthorityEventJournal({ dispatch });

    journal.append(event("authority-requested"));
    journal.append(event("authority-decided"));
    journal.append(event("authority-requested", { objectKey: "other-owner", runId: "other-run" }));

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls.map((call) => call[0].objectKey)).toEqual(["owner", "other-owner"]);
    releaseFirst();
    await journal.close();

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls[2]?.slice(1, 4)).toEqual([
      "appendAuthorityEvent",
      "run-1",
      "authority-decided",
    ]);
  });

  it("reports a failed append and continues the ordered journal", async () => {
    const onError = vi.fn();
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("generation replaced"))
      .mockResolvedValueOnce(undefined);
    const journal = new EvalAuthorityEventJournal({ dispatch }, onError);

    journal.append(event("authority-requested"));
    journal.append(event("authority-decided"));
    await journal.close();

    expect(onError).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not let a failing error reporter poison later delivery", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("generation replaced"))
      .mockResolvedValueOnce(undefined);
    const journal = new EvalAuthorityEventJournal({ dispatch }, () => {
      throw new Error("reporter failed");
    });

    journal.append(event("authority-requested"));
    journal.append(event("authority-decided"));
    await journal.close();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(consoleWarn).toHaveBeenCalledOnce();
    consoleWarn.mockRestore();
  });

  it("refuses new observations after shutdown begins", async () => {
    const journal = new EvalAuthorityEventJournal({ dispatch: vi.fn() });
    await journal.close();
    expect(() => journal.append(event("authority-requested"))).toThrow(/journal is closed/);
  });
});
