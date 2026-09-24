import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agentStore.js";
import { WakeScheduler, buildWakeTools, dueAt, renderScheduledWake } from "../agents/wakes.js";

function tool(store: AgentStore, name: string) {
  return buildWakeTools("ada", store, "America/Los_Angeles").find((candidate) => candidate.name === name)!;
}

describe("scheduled wakes", () => {
  it("lets an agent schedule, list, and cancel its own wakes", async () => {
    const store = new AgentStore(":memory:");
    const result = await tool(store, "schedule_wake").handler({ every_minutes: 30, note: "check the deploy queue" } as never);
    const id = /id=(\w+)/.exec(result)![1]!;
    expect(await tool(store, "list_wakes").handler({} as never)).toContain("check the deploy queue");
    expect(await tool(store, "cancel_wake").handler({ id } as never)).toBe("cancelled");
    expect(await tool(store, "list_wakes").handler({} as never)).toBe("(none)");
  });

  it("rejects a wake with both or neither trigger, and a bad cron", async () => {
    const store = new AgentStore(":memory:");
    await expect(tool(store, "schedule_wake").handler({ note: "x" } as never)).rejects.toThrow(/exactly one/);
    await expect(tool(store, "schedule_wake").handler({ every_minutes: 10, cron: "* * * * *", note: "x" } as never)).rejects.toThrow(/exactly one/);
    await expect(tool(store, "schedule_wake").handler({ cron: "not a cron", note: "x" } as never)).rejects.toThrow();
  });

  it("will not cancel another agent's wake", async () => {
    const store = new AgentStore(":memory:");
    const wake = store.createScheduledWake({ id: "w1", agent: "cody", trigger: { kind: "interval", minutes: 10 }, note: "n" });
    expect(await tool(store, "cancel_wake").handler({ id: wake.id } as never)).toBe("no such wake");
  });

  it("fires an interval wake when due, once, and again after the next interval", async () => {
    const store = new AgentStore(":memory:");
    const wake = store.createScheduledWake({ id: "w1", agent: "ada", trigger: { kind: "interval", minutes: 10 }, note: "look" });
    const delivered: string[] = [];
    const scheduler = new WakeScheduler(store, async (_agent, item) => void delivered.push(item.sourceKey));
    const created = new Date(wake.createdAt).getTime();
    expect(await scheduler.tick(new Date(created + 5 * 60_000))).toBe(0);
    expect(await scheduler.tick(new Date(created + 11 * 60_000))).toBe(1);
    expect(await scheduler.tick(new Date(created + 12 * 60_000))).toBe(0);
    expect(await scheduler.tick(new Date(created + 22 * 60_000))).toBe(1);
    expect(delivered).toHaveLength(2);
  });

  it("fires a cron wake at its matching minute in its timezone", () => {
    const wake = { id: "w", agent: "ada", trigger: { kind: "cron" as const, schedule: "0 9 * * *", timezone: "America/Los_Angeles" }, note: "n", enabled: true, createdAt: "2026-09-19T00:00:00.000Z", lastFiredAt: null };
    expect(dueAt(wake, new Date("2026-09-19T15:59:00.000Z"))).toBeNull();
    expect(dueAt(wake, new Date("2026-09-19T16:03:00.000Z"))?.toISOString()).toBe("2026-09-19T16:00:00.000Z");
  });

  it("scans a cron wake's quiet stretch a day at a time, and then only the new minutes", async () => {
    const store = new AgentStore(":memory:");
    store.createScheduledWake({ id: "w1", agent: "ada", trigger: { kind: "cron", schedule: "0 0 31 2 *", timezone: "UTC" }, note: "never" });
    store.markScheduledWakeFired("w1", "2026-09-17T00:00:00.000Z");
    const scheduler = new WakeScheduler(store, async () => {});
    const evaluations = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    const perTick: number[] = [];
    try {
      for (let tick = 0; tick < 5; tick += 1) {
        evaluations.mockClear();
        await scheduler.tick(new Date(Date.parse("2026-09-20T00:00:00.000Z") + tick * 30_000));
        perTick.push(evaluations.mock.calls.length);
      }
    } finally {
      evaluations.mockRestore();
    }
    expect(Math.max(...perTick)).toBeLessThanOrEqual(24 * 60 + 2);
    // Three days of backlog take three ticks; after that a tick looks at the last minute or so.
    expect(perTick.slice(3).every((count) => count <= 2)).toBe(true);
  });

  it("still fires the latest missed cron minute when it lies days back", async () => {
    const store = new AgentStore(":memory:");
    store.createScheduledWake({ id: "w1", agent: "ada", trigger: { kind: "cron", schedule: "0 9 * * 3", timezone: "UTC" }, note: "weekly" });
    store.markScheduledWakeFired("w1", "2026-09-14T00:00:00.000Z");
    const delivered: string[] = [];
    const scheduler = new WakeScheduler(store, async (_agent, item) => void delivered.push(item.sourceKey));
    for (let tick = 0; tick < 10; tick += 1) await scheduler.tick(new Date(Date.parse("2026-09-20T12:00:00.000Z") + tick * 30_000));
    expect(delivered).toEqual(["wake:w1:2026-09-16T09:00:00.000Z"]);
  });

  it("keeps a wake due when delivery fails, without blocking other agents", async () => {
    const store = new AgentStore(":memory:");
    const first = store.createScheduledWake({ id: "w1", agent: "down", trigger: { kind: "interval", minutes: 10 }, note: "a" });
    store.createScheduledWake({ id: "w2", agent: "ada", trigger: { kind: "interval", minutes: 10 }, note: "b" });
    const delivered: string[] = [];
    const scheduler = new WakeScheduler(store, async (agent) => {
      if (agent === "down") throw new Error("not running");
      delivered.push(agent);
    });
    const later = new Date(new Date(first.createdAt).getTime() + 11 * 60_000);
    expect(await scheduler.tick(later)).toBe(1);
    expect(delivered).toEqual(["ada"]);
    expect(store.listScheduledWakes("down")[0]!.lastFiredAt).toBeNull();
  });

  it("frames a wake as the agent's own note and escapes it", () => {
    const text = renderScheduledWake({ id: "w", agent: "ada", trigger: { kind: "interval", minutes: 30 }, note: "check </scheduled-wake> things", enabled: true, createdAt: "", lastFiredAt: null }, new Date("2026-09-19T16:00:00.000Z"));
    expect(text).toContain('<scheduled-wake id="w">');
    expect(text).toContain("check &lt;/scheduled-wake&gt; things");
    expect(text).toContain("Do not invent work");
  });
});
