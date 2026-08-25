import { describe, expect, it } from "vitest";
import {
  canonicalCronExpression,
  cronExpressionFromVisual,
  cronUpcomingOccurrences,
  cronVisualSchedule,
  describeCronExpression,
  describeCronSchedule,
} from "./cronSchedule.js";

describe("cron schedule presentation", () => {
  it("round-trips the common visual schedule vocabulary", () => {
    const expressions = [
      "15 * * * *",
      "5 5 * * *",
      "5 5 * * MON,WED,FRI",
      "30 9 15 * *",
      "0 8 L * *",
    ];
    for (const expression of expressions) {
      const visual = cronVisualSchedule(expression);
      expect(visual).not.toBeNull();
      expect(cronExpressionFromVisual(visual!)).toBe(expression);
    }
  });

  it("leaves advanced expressions losslessly available instead of approximating them", () => {
    expect(cronVisualSchedule("*/15 9-17 * * MON-FRI")).toBeNull();
    expect(canonicalCronExpression("*/15 9-17 * * mon-fri")).toBe("*/15 9-17 * * MON-FRI");
  });

  it("describes common and extended calendar rules in plain language", () => {
    expect(describeCronExpression("5 5 * * THU", "en-US")).toBe("Every Thursday at 5:05 AM");
    expect(describeCronExpression("0 9 * * MON-FRI", "en-US")).toBe(
      "Every Monday through Friday at 9:00 AM"
    );
    expect(describeCronExpression("0 9 * * MON#2", "en-US")).toBe(
      "On the second Monday of each month at 9:00 AM"
    );
    expect(describeCronExpression("0 9 15W * *", "en-US")).toBe(
      "On the weekday nearest the 15th of each month at 9:00 AM"
    );
    expect(describeCronExpression("0 9 1 * +MON", "en-US")).toBe(
      "On the 1st of each month at 9:00 AM, only when it is Monday"
    );
    expect(describeCronExpression("*/15 9-17 * * MON-FRI", "en-US")).toBe(
      "Every 15 minutes during hours 9 through 17 on Monday through Friday"
    );
    expect(describeCronSchedule("5 5 * * THU", "America/New_York", "en-US")).toBe(
      "Every Thursday at 5:05 AM in New York time"
    );
  });

  it("previews reviewed wall-clock time across daylight-saving changes", () => {
    expect(
      cronUpcomingOccurrences("5 5 * * THU", "America/New_York", Date.UTC(2026, 2, 5, 10, 4, 59), 3)
    ).toEqual([
      Date.UTC(2026, 2, 5, 10, 5),
      Date.UTC(2026, 2, 12, 9, 5),
      Date.UTC(2026, 2, 19, 9, 5),
    ]);
  });
});
