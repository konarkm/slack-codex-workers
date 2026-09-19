import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logError } from "../logger.js";
import { findLatestMatchingCronMinute, validateCronSchedule } from "../registrations/cron.js";
import type { AgentStore, ScheduledWake } from "./agentStore.js";
import type { AgentTool } from "./types.js";

// When a wake is due, as of `now`. Returns the due instant, or null if it is not due yet.
export function dueAt(wake: ScheduledWake, now: Date): Date | null {
  const since = new Date(wake.lastFiredAt ?? wake.createdAt);
  if (wake.trigger.kind === "interval") {
    const due = new Date(since.getTime() + wake.trigger.minutes * 60_000);
    return due.getTime() <= now.getTime() ? due : null;
  }
  return findLatestMatchingCronMinute(wake.trigger.schedule, wake.trigger.timezone, since, now);
}

function describeTrigger(wake: ScheduledWake): string {
  return wake.trigger.kind === "interval" ? `every ${wake.trigger.minutes} minutes` : `cron "${wake.trigger.schedule}" (${wake.trigger.timezone})`;
}

// A scheduled wake is the agent's own note to itself. The clamps keep a quiet wake from turning into invented work.
export function renderScheduledWake(wake: ScheduledWake, due: Date): string {
  return [
    `<scheduled-wake id="${wake.id}">`,
    `Trigger: ${describeTrigger(wake)}`,
    `Due: ${due.toISOString()}`,
    "Your note to yourself when you set this:",
    wake.note.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    "</scheduled-wake>",
    "",
    "No message arrived; this wake is one you scheduled. Do what the note says and nothing more. If there is nothing to do, call dismiss and end the turn. Do not invent work, and do not post just to say you checked.",
  ].join("\n");
}

export interface WakeDelivery {
  (agent: string, item: { sourceKey: string; text: string }): Promise<unknown>;
}

// Fires due wakes into their agents' inboxes. The inbox source key makes a wake that is due once arrive once.
export class WakeScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: AgentStore,
    private readonly deliver: WakeDelivery,
    private readonly intervalMs = 30_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(new Date()).catch(() => {}), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: Date): Promise<number> {
    let fired = 0;
    for (const wake of this.store.listScheduledWakes()) {
      if (!wake.enabled) continue;
      const due = dueAt(wake, now);
      if (!due) continue;
      try {
        await this.deliver(wake.agent, { sourceKey: `wake:${wake.id}:${due.toISOString()}`, text: renderScheduledWake(wake, due) });
      } catch (error) {
        // Stays due; one agent's failure must not hold back the others.
        logError("scheduled wake not delivered", { agent: wake.agent, wakeId: wake.id, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      this.store.markScheduledWakeFired(wake.id, now.toISOString());
      fired += 1;
    }
    return fired;
  }
}

function defineTool<Shape extends z.ZodRawShape>(tool: AgentTool<Shape>): AgentTool {
  return tool as unknown as AgentTool;
}

export function buildWakeTools(agent: string, store: AgentStore, defaultTimezone: string): AgentTool[] {
  return [
    defineTool({
      name: "schedule_wake",
      description:
        "Schedule yourself to be woken later, once per interval or on a cron schedule, with a note to yourself about what to do then. Use it for standing responsibilities and for checking back on something, instead of waiting inside a turn.",
      shape: {
        every_minutes: z.number().int().min(5).max(10080).optional().describe("Wake every N minutes. Give this or cron, not both."),
        cron: z.string().optional().describe("Five-field cron expression, e.g. '0 9 * * 1-5'."),
        timezone: z.string().optional().describe("IANA timezone for cron. Defaults to the workspace timezone."),
        note: z.string().min(1).describe("What you should do when this fires, written so you can act on it cold."),
      },
      handler: async (args) => {
        if ((args.every_minutes === undefined) === (args.cron === undefined)) throw new Error("Give exactly one of every_minutes or cron.");
        if (args.cron) validateCronSchedule(args.cron);
        const wake = store.createScheduledWake({
          id: randomUUID().slice(0, 8),
          agent,
          trigger: args.cron ? { kind: "cron", schedule: args.cron, timezone: args.timezone ?? defaultTimezone } : { kind: "interval", minutes: args.every_minutes! },
          note: args.note,
        });
        return `scheduled. id=${wake.id} (${describeTrigger(wake)})`;
      },
    }),
    defineTool({
      name: "list_wakes",
      description: "List the wakes you have scheduled for yourself.",
      shape: {},
      handler: async () => {
        const wakes = store.listScheduledWakes(agent).filter((wake) => wake.enabled);
        return wakes.length > 0 ? wakes.map((wake) => `${wake.id} · ${describeTrigger(wake)} · last fired ${wake.lastFiredAt ?? "never"} · ${wake.note}`).join("\n") : "(none)";
      },
    }),
    defineTool({
      name: "cancel_wake",
      description: "Cancel one of your scheduled wakes by id.",
      shape: { id: z.string().min(1) },
      handler: async (args) => (store.disableScheduledWake(agent, args.id) ? "cancelled" : "no such wake"),
    }),
  ];
}
