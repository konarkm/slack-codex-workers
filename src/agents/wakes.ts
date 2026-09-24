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

// How much of a cron wake's unscanned past one tick looks at: a few milliseconds.
const CRON_BACKLOG_SLICE_MS = 24 * 60 * 60_000;

// The part of a cron wake's window already scanned with no match: (from, to], for the window that starts at `since`.
interface CronCursor {
  since: number;
  from: number;
  to: number;
}

// Fires due wakes into their agents' inboxes. The inbox source key makes a wake that is due once arrive once.
export class WakeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly cronCursors = new Map<string, CronCursor>();

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
    // A slow delivery must not let the next tick start on top of this one.
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await this.fireDue(now);
    } finally {
      this.ticking = false;
    }
  }

  private async fireDue(now: Date): Promise<number> {
    let fired = 0;
    const wakes = this.store.listScheduledWakes().filter((wake) => wake.enabled);
    for (const id of this.cronCursors.keys()) {
      if (!wakes.some((wake) => wake.id === id)) this.cronCursors.delete(id);
    }
    for (const wake of wakes) {
      let due: Date | null;
      try {
        due = wake.trigger.kind === "cron" ? this.cronDueAt(wake, wake.trigger, now) : dueAt(wake, now);
      } catch (error) {
        // One unreadable schedule must not stop everyone else's wakes.
        logError("scheduled wake could not be evaluated", { agent: wake.agent, wakeId: wake.id, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
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

  // dueAt for a cron wake, but each tick scans only minutes no earlier tick has: the new ones since the last tick, then at
  // most a slice of the older window. A sparse schedule would otherwise rescan weeks of minutes every tick. A match more
  // than a slice back (after the hub was down) is found a few ticks late.
  private cronDueAt(wake: ScheduledWake, trigger: { schedule: string; timezone: string }, now: Date): Date | null {
    const since = Date.parse(wake.lastFiredAt ?? wake.createdAt);
    const cursor = this.cronCursors.get(wake.id);
    const scanned = cursor && cursor.since === since ? cursor : { since, from: now.getTime(), to: now.getTime() };
    this.cronCursors.set(wake.id, scanned);
    // Newest first, so the first match found is the latest one.
    const recent = findLatestMatchingCronMinute(trigger.schedule, trigger.timezone, new Date(scanned.to), now);
    if (recent) return recent;
    scanned.to = Math.max(scanned.to, now.getTime());
    if (scanned.from <= since) return null;
    const sliceStart = Math.max(since, scanned.from - CRON_BACKLOG_SLICE_MS);
    const older = findLatestMatchingCronMinute(trigger.schedule, trigger.timezone, new Date(sliceStart), new Date(scanned.from));
    if (older) return older;
    scanned.from = sliceStart;
    return null;
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
        const timezone = args.timezone ?? defaultTimezone;
        if (args.cron) {
          validateCronSchedule(args.cron);
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: timezone });
          } catch {
            throw new Error(`Unknown timezone "${timezone}". Use an IANA name such as America/Los_Angeles.`);
          }
        }
        const wake = store.createScheduledWake({
          id: randomUUID().slice(0, 8),
          agent,
          trigger: args.cron ? { kind: "cron", schedule: args.cron, timezone } : { kind: "interval", minutes: args.every_minutes! },
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
