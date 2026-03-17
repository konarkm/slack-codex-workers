import { afterEach, describe, expect, it } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("config", () => {
  it("rejects invalid WEBHOOK_PUBLIC_BASE_URL values", async () => {
    process.env = {
      ...originalEnv,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_ADMIN_USER_IDS: "U-admin",
      WEBHOOK_PUBLIC_BASE_URL: "ftp://invalid.example.test",
    };

    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig()).toThrow("Invalid WEBHOOK_PUBLIC_BASE_URL");
  });
});
