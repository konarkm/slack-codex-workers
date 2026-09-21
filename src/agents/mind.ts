import { createHash, randomUUID } from "node:crypto";
import { logError, logInfo } from "../logger.js";
import type { AgentStore, InboxItem, NewInboxItem } from "./agentStore.js";
import type { AgentRuntime, AgentSpec, AgentTool, InputPriority, RuntimeEvents, RuntimeOptions, RuntimeState, TurnCompletion } from "./types.js";

// An input that makes three turns fail by itself is given up on. Failures that are not the input's fault never count.
const MAX_INPUT_FAULTS = 3;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 300_000;
// Consecutive failed turns before the operators are told the agent is in trouble.
const TROUBLE_AFTER_FAILURES = 3;

export type RuntimeFactory = (options: RuntimeOptions) => AgentRuntime;

export interface MindObserver {
  onStateChanged?(agent: string, state: RuntimeState): void | Promise<void>;
  onTurnCompleted?(agent: string, event: TurnCompletion): void | Promise<void>;
  // Input the bridge has stopped trying to deliver. People are waiting on it, so this must reach an operator.
  onAbandoned?(agent: string, items: InboxItem[], reason: string): void | Promise<void>;
  // The agent keeps failing. Its input is held and retried, nothing is lost, but someone should look.
  onTrouble?(agent: string, message: string): void | Promise<void>;
}

const PRIORITY_RANK: Record<InputPriority, number> = { now: 0, next: 1, later: 2 };

const SILENT_TURN_NOTICE = [
  "[bridge notice]",
  "Your last turn ended without any visible action. Nobody sees your turn output; people only see what you send with your tools.",
  "If a reply is due, send it now. If none is due, call dismiss with a short reason so the record shows you chose not to reply.",
].join("\n");

const MID_TURN_NOTE =
  "Note: this arrived while you were working. Continue your in-progress work and take this into account if it is relevant; if it is unrelated, handle it without abandoning what you were doing.";

// A session keeps the instructions it started with: Claude's system prompt is a snapshot until compaction, and a Codex
// thread holds them as its opening message and ignores new ones sent on resume (checked in a live thread's record).
// So a running agent would go on following instructions that have since changed. It is handed the current ones once,
// with its next input.
const INSTRUCTIONS_CHANGED_NOTE =
  "[bridge notice] Your standing instructions have changed since this session began. The current version follows and replaces the earlier one wherever they differ. Do not announce this to anyone.";

const REDELIVERY_NOTE =
  "[bridge notice] Some of what follows was delivered to you before, but the bridge could not confirm you finished with it (a failed turn or a restart). Check what you already did about it, and skip anything you already handled.";

// One named agent's mind. Every surface feeds the same durable inbox, and the inbox feeds one provider session.
export class AgentMind {
  private runtime: AgentRuntime | null = null;
  // Identifies the runtime whose events still count; events from a runtime that was replaced or stopped are ignored.
  private runtimeToken: object | null = null;
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private pumpActive = false;
  private stopped = false;
  private visibleActionSinceWake = false;
  private noticeSentForWake = false;
  private awaitingVisibleAction = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = FIRST_RETRY_MS;
  private holdUntil = 0;
  private consecutiveFailures = 0;
  // Inbox rows behind each input handed to the runtime.
  private readonly inputRows = new Map<string, number[]>();

  constructor(
    readonly spec: AgentSpec,
    private readonly store: AgentStore,
    private readonly createRuntime: RuntimeFactory,
    private readonly instructions: string,
    private readonly tools: AgentTool[],
    private readonly observer: MindObserver = {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    // Input handed to a runtime that never confirmed it (a crash or restart) goes back in the queue.
    this.store.requeueAllInFlight(this.spec.name);
    this.ensureRuntime();
    await this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.pumping?.catch(() => {});
    await this.detachRuntime()?.stop();
  }

  state(): RuntimeState {
    return this.runtime?.state() ?? "down";
  }

  sessionId(): string | null {
    return this.runtime?.sessionId() ?? this.store.getAgentState(this.spec.name)?.sessionId ?? null;
  }

  // Accepts one input from any surface. Returns false when this source event was already received.
  async receive(item: Omit<NewInboxItem, "agent">): Promise<boolean> {
    const stored = this.store.enqueue({ ...item, agent: this.spec.name });
    if (!stored) return false;
    await this.pump();
    return true;
  }

  // Tools that people can see (send, react, dismiss) report here, so a silent turn can be told it was silent.
  noteVisibleAction(): void {
    this.visibleActionSinceWake = true;
  }

  async interrupt(): Promise<void> {
    await this.runtime?.interrupt();
  }

  async compact(): Promise<void> {
    // Compaction is a turn of its own; it owes nobody a visible action.
    this.awaitingVisibleAction = false;
    await this.ensureRuntime().compact();
  }

  // Forget the provider session; the next input starts a fresh one. The inbox is untouched.
  async resetSession(): Promise<void> {
    // Detach first: a stopping runtime reports `down`, and that must not restart the session being thrown away.
    const old = this.detachRuntime();
    this.store.setAgentSession(this.spec.name, null);
    this.store.requeueAllInFlight(this.spec.name);
    await old?.stop();
  }

  private detachRuntime(): AgentRuntime | null {
    const old = this.runtime;
    this.runtime = null;
    this.runtimeToken = null;
    this.inputRows.clear();
    return old;
  }

  private ensureRuntime(): AgentRuntime {
    if (this.runtime) return this.runtime;
    const token = {};
    const current = (): boolean => this.runtimeToken === token;
    const events: RuntimeEvents = {
      onSessionChanged: (sessionId) => {
        if (current()) this.store.setAgentSession(this.spec.name, sessionId);
      },
      onStateChanged: async (state) => {
        if (!current()) return;
        if (state === "down") {
          this.inputRows.clear();
          this.store.requeueAllInFlight(this.spec.name);
        }
        await this.observer.onStateChanged?.(this.spec.name, state);
        // Not awaited: this fires inside deliver(), which the pump itself is awaiting.
        if (state !== "running") void this.pump().catch(() => {});
      },
      onTurnCompleted: async (event) => {
        if (!current()) return;
        await this.settleTurn(event);
        await this.observer.onTurnCompleted?.(this.spec.name, event);
        await this.afterTurn(event).catch((error) => {
          logError("silent-turn notice not delivered", { agent: this.spec.name, error: errorMessage(error) });
        });
      },
      onActivity: () => {},
      onProblem: (message) => {
        if (current()) this.store.setAgentError(this.spec.name, message);
      },
      onCompaction: (event) => {
        logInfo("agent compaction", { agent: this.spec.name, status: event.status });
      },
    };
    this.runtimeToken = token;
    this.runtime = this.createRuntime({
      spec: this.spec,
      sessionId: this.store.getAgentState(this.spec.name)?.sessionId ?? null,
      instructions: this.instructions,
      tools: this.tools,
      events,
    });
    return this.runtime;
  }

  // Input counts as delivered only when the turn that took it has ended. A failed turn puts it back.
  private async settleTurn(event: TurnCompletion): Promise<void> {
    const rows = event.consumedInputIds.flatMap((id) => {
      const ids = this.inputRows.get(id) ?? [];
      this.inputRows.delete(id);
      return ids;
    });
    if (event.status !== "failed") {
      // An operator's stop ends the work it interrupted; that input is not delivered again.
      this.store.markDelivered(rows);
      this.store.setAgentError(this.spec.name, null);
      this.retryDelayMs = FIRST_RETRY_MS;
      this.consecutiveFailures = 0;
      return;
    }
    const reason = event.error ?? "the turn failed";
    this.store.setAgentError(this.spec.name, reason);
    const abandoned = this.store.requeue(rows, event.inputFault, MAX_INPUT_FAULTS);
    if (abandoned.length > 0) {
      const message = `Gave up on ${abandoned.length} input(s) that made ${MAX_INPUT_FAULTS} turns fail (${reason}): ${abandoned.map((item) => item.sourceKey).join(", ")}`;
      logError(message, { agent: this.spec.name });
      this.store.setAgentError(this.spec.name, message);
      await this.observer.onAbandoned?.(this.spec.name, abandoned, reason);
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === TROUBLE_AFTER_FAILURES) {
      await this.observer.onTrouble?.(this.spec.name, `${this.consecutiveFailures} turns in a row have failed (${reason}). Input is held and retried; nothing has been dropped.`);
    }
    this.scheduleRetry();
  }

  private async afterTurn(event: TurnCompletion): Promise<void> {
    if (!this.awaitingVisibleAction || event.status !== "completed") return;
    if (this.visibleActionSinceWake || this.noticeSentForWake) {
      this.awaitingVisibleAction = false;
      return;
    }
    this.noticeSentForWake = true;
    await this.ensureRuntime().deliver({ id: null, text: SILENT_TURN_NOTICE, imagePaths: [], priority: "next" });
  }

  private pump(): Promise<void> {
    // The flag is set before any work starts, so a call made from inside a delivery never starts a second pump.
    if (this.pumpActive) {
      this.pumpAgain = true;
      return this.pumping ?? Promise.resolve();
    }
    this.pumpActive = true;
    this.pumping = (async () => {
      try {
        do {
          this.pumpAgain = false;
          await this.deliverQueued();
        } while (this.pumpAgain);
      } finally {
        this.pumpActive = false;
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  // After a failure, wait before trying again, longer each time, so an outage is ridden out instead of hammered.
  private scheduleRetry(): void {
    this.holdUntil = Date.now() + this.retryDelayMs;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.holdUntil = 0;
      void this.pump().catch(() => {});
    }, this.retryDelayMs);
    this.retryTimer.unref();
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
  }

  private instructionsUpdate(): string[] {
    const hash = createHash("sha256").update(this.instructions).digest("hex").slice(0, 16);
    const known = this.store.instructionsHash(this.spec.name);
    if (known === hash) return [];
    this.store.setInstructionsHash(this.spec.name, hash);
    // A session that has not started yet reads them as it starts.
    const running = Boolean(this.store.getAgentState(this.spec.name)?.sessionId);
    return running ? [`${INSTRUCTIONS_CHANGED_NOTE}\n\n${this.instructions}`] : [];
  }

  // Context-only items wait in the inbox and ride along with the next item that wakes the agent.
  private async deliverQueued(): Promise<void> {
    if (this.stopped || Date.now() < this.holdUntil) return;
    const queued = this.store.listQueued(this.spec.name);
    if (!queued.some((item) => item.wake)) return;
    const runtime = this.ensureRuntime();
    const inputId = randomUUID();
    const notes = [
      ...this.instructionsUpdate(),
      ...(queued.some((item) => item.attempts > 0) ? [REDELIVERY_NOTE] : []),
      renderBatch(queued),
      ...(runtime.state() === "running" ? [MID_TURN_NOTE] : []),
    ];
    const rowIds = queued.map((item) => item.id);
    this.inputRows.set(inputId, rowIds);
    // Marked before the hand-off, so a turn that finishes at once still finds them in flight.
    this.store.markInFlight(rowIds);
    try {
      await runtime.deliver({
        id: inputId,
        text: notes.join("\n\n"),
        imagePaths: queued.flatMap((item) => item.imagePaths),
        priority: queued.reduce<InputPriority>((best, item) => (PRIORITY_RANK[item.priority] < PRIORITY_RANK[best] ? item.priority : best), "later"),
      });
    } catch (error) {
      this.inputRows.delete(inputId);
      this.store.returnUndelivered(rowIds);
      const message = errorMessage(error);
      this.store.setAgentError(this.spec.name, message);
      logError("agent delivery failed; input stays queued", { agent: this.spec.name, error: message, retryInMs: this.retryDelayMs });
      this.scheduleRetry();
      throw error;
    }
    this.visibleActionSinceWake = false;
    this.noticeSentForWake = false;
    this.awaitingVisibleAction = true;
  }
}

export function renderBatch(items: InboxItem[]): string {
  if (items.length === 1) return items[0]!.text;
  const context = items.filter((item) => !item.wake);
  const waking = items.filter((item) => item.wake);
  const sections: string[] = [];
  if (context.length > 0) {
    sections.push(`Other activity you can see, delivered for context (${context.length}):`, ...context.map((item) => item.text));
  }
  sections.push(waking.length === 1 ? "This woke you:" : `These woke you (${waking.length}):`, ...waking.map((item) => item.text));
  return sections.join("\n\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
