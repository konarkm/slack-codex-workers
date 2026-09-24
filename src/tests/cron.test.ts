import { describe, expect, it } from "vitest";
import { findLatestMatchingCronMinute, validateCronSchedule } from "../registrations/cron.js";

describe("cron schedule matching", () => {
  it("finds the latest matching minute for a wildcard schedule", () => {
    const match = findLatestMatchingCronMinute(
      "* * * * *",
      "UTC",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:03:42.000Z"),
    );
    expect(match?.toISOString()).toBe("2026-01-01T00:03:00.000Z");
  });

  it("supports steps and exact hours", () => {
    const match = findLatestMatchingCronMinute(
      "*/15 9 * * *",
      "UTC",
      new Date("2026-01-01T08:00:00.000Z"),
      new Date("2026-01-01T09:46:00.000Z"),
    );
    expect(match?.toISOString()).toBe("2026-01-01T09:45:00.000Z");
  });

  it("returns null when no matching minute exists in the interval", () => {
    const match = findLatestMatchingCronMinute(
      "0 9 * * *",
      "UTC",
      new Date("2026-01-01T09:00:00.000Z"),
      new Date("2026-01-01T09:10:00.000Z"),
    );
    expect(match).toBeNull();
  });

  it("uses OR semantics when both day-of-month and day-of-week are restricted", () => {
    const match = findLatestMatchingCronMinute(
      "0 9 1 * 1",
      "UTC",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-05T09:00:00.000Z"),
    );
    expect(match?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("treats a stepped wildcard day field like a wildcard, as cron does", () => {
    // Monday 2026-09-21 noon to Tuesday noon: a Monday-only schedule has no match in it.
    const since = new Date("2026-09-21T12:00:00.000Z");
    const now = new Date("2026-09-22T12:00:00.000Z");
    expect(findLatestMatchingCronMinute("0 9 * * 1", "UTC", since, now)).toBeNull();
    expect(findLatestMatchingCronMinute("0 9 */1 * 1", "UTC", since, now)).toBeNull();
    expect(findLatestMatchingCronMinute("0 9 * * */1", "UTC", since, now)?.toISOString()).toBe("2026-09-22T09:00:00.000Z");
  });

  it("matches using the provided timezone", () => {
    const match = findLatestMatchingCronMinute(
      "0 9 * * *",
      "America/Los_Angeles",
      new Date("2026-01-01T16:00:00.000Z"),
      new Date("2026-01-01T17:05:00.000Z"),
    );
    expect(match?.toISOString()).toBe("2026-01-01T17:00:00.000Z");
  });

  it("rejects invalid cron schedules", () => {
    expect(() => validateCronSchedule("bad cron")).toThrow();
    expect(() => validateCronSchedule("61 * * * *")).toThrow();
  });
});
