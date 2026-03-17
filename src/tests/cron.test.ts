import { describe, expect, it } from "vitest";
import { findLatestMatchingCronMinute } from "../registrations/cron.js";

describe("cron schedule matching", () => {
  it("finds the latest matching minute for a wildcard schedule", () => {
    const match = findLatestMatchingCronMinute(
      "* * * * *",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:03:42.000Z"),
    );
    expect(match?.toISOString()).toBe("2026-01-01T00:03:00.000Z");
  });

  it("supports steps and exact hours", () => {
    const match = findLatestMatchingCronMinute(
      "*/15 9 * * *",
      new Date("2026-01-01T08:00:00.000Z"),
      new Date("2026-01-01T09:46:00.000Z"),
    );
    expect(match?.toISOString()).toBe("2026-01-01T09:45:00.000Z");
  });

  it("returns null when no matching minute exists in the interval", () => {
    const match = findLatestMatchingCronMinute(
      "0 9 * * *",
      new Date("2026-01-01T09:00:00.000Z"),
      new Date("2026-01-01T09:10:00.000Z"),
    );
    expect(match).toBeNull();
  });
});
