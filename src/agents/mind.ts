import { createHash, randomUUID } from "node:crypto";
import { logError, logInfo } from "../logger.js";
import type { AgentStore, InboxItem, NewInboxItem } from "./agentStore.js";
import type { AgentRuntime, AgentSpec, AgentTool, InputPriority, RuntimeEvents, RuntimeOptions, RuntimeState, TurnCompletion } from "./types.js";

// An input that makes three turns fail by itself is given up on. Failures that are not the input's fault never count.
const MAX_INPUT_FAULTS = 3;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 300_000;
// Consecutive failures (turns that failed, or hand-offs the runtime could not take) before the operators are told the
// agent is in trouble.
const TROUBLE_AFTER_FAILURES = 3;
// How long a stop request waits for the harness to confirm the interrupt.
const INTERRUPT_WAIT_MS = 10_000;

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
  // Rows of a batch whose turn failed through some input's fault. Each goes alone until it is settled, so the fault is
  // charged to the row that causes it, not to everything that happened to be queued with it.
  private readonly isolating = new Set<number>();
  // The input carrying changed instructions. They count as known only once the turn that took it has finished.
  private instructionsInput: { id: string; hash: string } | null = null;
  // Something wrong with the runtime that it reported. It stays the last error, past good turns, until the runtime goes.
  private problem: string | null = null;

  constructor(
    readonly spec: AgentSpec,
    private readonly store: AgentStore,
    private readonly createRuntime: RuntimeFactory,
    private readonly instructions: string,
    private readonly tools: AgentTool[],
    private readonly toolAccess: RuntimeOptions["toolAccess"],
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
  // Returns once the input is stored: handing it over can take minutes (a Codex app-server starting), and every other
  // agent's intake would wait behind it.
  async receive(item: Omit<NewInboxItem, "agent">): Promise<boolean> {
    const stored = this.store.enqueue({ ...item, agent: this.spec.name });
    if (!stored) return false;
    void this.pump().catch((error) => logError("agent delivery failed", { agent: this.spec.name, error: errorMessage(error) }));
    return true;
  }

  // Tools that people can see (send, react, dismiss) report here, so a silent turn can be told it was silent.
  noteVisibleAction(): void {
    this.visibleActionSinceWake = true;
  }

  // A hung runtime must not hold up whoever asked for the stop: past the wait, the interrupt carries on without them.
  async interrupt(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const attempt = runtime.interrupt();
    attempt.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`interrupt not confirmed within ${INTERRUPT_WAIT_MS / 1000} s`)), INTERRUPT_WAIT_MS);
    });
    try {
      await Promise.race([attempt, late]);
    } finally {
      clearTimeout(timer);
    }
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
    // What was put back goes to the new session now, not with whatever wakes the agent next, and without the old backoff.
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.holdUntil = 0;
    this.retryDelayMs = FIRST_RETRY_MS;
    void this.pump().catch((error) => logError("agent delivery failed", { agent: this.spec.name, error: errorMessage(error) }));
  }

  private detachRuntime(): AgentRuntime | null {
    const old = this.runtime;
    this.runtime = null;
    this.runtimeToken = null;
    this.forgetInFlight();
    return old;
  }

  // The runtime holding the in-flight input is gone; that input goes back in the queue.
  private forgetInFlight(): void {
    this.inputRows.clear();
    this.instructionsInput = null;
    this.problem = null;
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
          this.forgetInFlight();
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
      // Bridge tools missing, a lost session: the agent may be unable to speak, so an operator hears of it.
      onProblem: async (message) => {
        if (!current()) return;
        this.problem = message;
        this.store.setAgentError(this.spec.name, message);
        await this.observer.onTrouble?.(this.spec.name, message);
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
      toolAccess: this.toolAccess,
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
    const instructions = this.instructionsInput;
    if (instructions && event.consumedInputIds.includes(instructions.id)) {
      this.instructionsInput = null;
      if (event.status !== "failed") this.store.setInstructionsHash(this.spec.name, instructions.hash);
    }
    if (event.status !== "failed") {
      // An operator's stop ends the work it interrupted; that input is not delivered again.
      this.store.markDelivered(rows);
      for (const id of rows) this.isolating.delete(id);
      this.store.setAgentError(this.spec.name, this.problem);
      this.retryDelayMs = FIRST_RETRY_MS;
      this.consecutiveFailures = 0;
      return;
    }
    const reason = event.error ?? "the turn failed";
    this.store.setAgentError(this.spec.name, reason);
    // Which row of a batch caused an input fault is unknown, so none is charged; each is sent alone to find out.
    const batchFault = event.inputFault && rows.length > 1;
    if (batchFault) for (const id of rows) this.isolating.add(id);
    const abandoned = this.store.requeue(rows, event.inputFault && !batchFault, MAX_INPUT_FAULTS);
    for (const item of abandoned) this.isolating.delete(item.id);
    if (abandoned.length > 0) {
      const message = `Gave up on ${abandoned.length} input(s) that made ${MAX_INPUT_FAULTS} turns fail (${reason}): ${abandoned.map((item) => item.sourceKey).join(", ")}`;
      logError(message, { agent: this.spec.name });
      this.store.setAgentError(this.spec.name, message);
      await this.observer.onAbandoned?.(this.spec.name, abandoned, reason);
    }
    this.scheduleRetry();
    await this.noteFailure(reason);
  }

  private async noteFailure(reason: string): Promise<void> {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === TROUBLE_AFTER_FAILURES) {
      await this.observer.onTrouble?.(this.spec.name, `${this.consecutiveFailures} attempts in a row have failed (${reason}). Input is held and retried; nothing has been dropped.`);
    }
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

  // The changed-instructions note for the input `inputId`, if the session has yet to be handed the current ones.
  private instructionsUpdate(inputId: string): string[] {
    const hash = createHash("sha256").update(this.instructions).digest("hex").slice(0, 16);
    if (this.store.instructionsHash(this.spec.name) === hash || this.instructionsInput?.hash === hash) return [];
    // A session that has not started yet reads them as it starts.
    if (!this.store.getAgentState(this.spec.name)?.sessionId) {
      this.store.setInstructionsHash(this.spec.name, hash);
      return [];
    }
    this.instructionsInput = { id: inputId, hash };
    return [`${INSTRUCTIONS_CHANGED_NOTE}\n\n${this.instructions}`];
  }

  // Context-only items wait in the inbox and ride along with the next item that wakes the agent. While a faulty row is
  // being looked for, the rows of the failed batch go one at a time, each after the one before it has finished.
  private nextBatch(queued: InboxItem[]): InboxItem[] | null {
    const inFlight = new Set([...this.inputRows.values()].flat());
    for (const id of this.isolating) if (!inFlight.has(id) && !queued.some((item) => item.id === id)) this.isolating.delete(id);
    if (this.isolating.size > 0) return inFlight.size > 0 ? null : queued.filter((item) => this.isolating.has(item.id)).slice(0, 1);
    return queued.some((item) => item.wake) ? queued : null;
  }

  private async deliverQueued(): Promise<void> {
    if (this.stopped || Date.now() < this.holdUntil) return;
    const batch = this.nextBatch(this.store.listQueued(this.spec.name));
    if (!batch) return;
    const runtime = this.ensureRuntime();
    const inputId = randomUUID();
    const notes = [
      ...this.instructionsUpdate(inputId),
      ...(batch.some((item) => item.attempts > 0) ? [REDELIVERY_NOTE] : []),
      renderBatch(batch),
      ...(runtime.state() === "running" ? [MID_TURN_NOTE] : []),
    ];
    const rowIds = batch.map((item) => item.id);
    this.inputRows.set(inputId, rowIds);
    // Marked before the hand-off, so a turn that finishes at once still finds them in flight.
    this.store.markInFlight(rowIds);
    try {
      await runtime.deliver({
        id: inputId,
        text: notes.join("\n\n"),
        imagePaths: batch.flatMap((item) => item.imagePaths),
        priority: batch.reduce<InputPriority>((best, item) => (PRIORITY_RANK[item.priority] < PRIORITY_RANK[best] ? item.priority : best), "later"),
      });
    } catch (error) {
      this.inputRows.delete(inputId);
      if (this.instructionsInput?.id === inputId) this.instructionsInput = null;
      this.store.returnUndelivered(rowIds);
      // A runtime replaced meanwhile (a reset) failing says nothing about its successor, which takes the input next.
      if (runtime !== this.runtime) {
        this.pumpAgain = true;
        return;
      }
      const message = errorMessage(error);
      this.store.setAgentError(this.spec.name, message);
      logError("agent delivery failed; input stays queued", { agent: this.spec.name, error: message, retryInMs: this.retryDelayMs });
      this.scheduleRetry();
      await this.noteFailure(message);
      return;
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
