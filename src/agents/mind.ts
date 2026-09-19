import { logError, logInfo } from "../logger.js";
import type { AgentStore, InboxItem, NewInboxItem } from "./agentStore.js";
import type { AgentRuntime, AgentSpec, AgentTool, InputPriority, RuntimeEvents, RuntimeOptions, RuntimeState, TurnStatus } from "./types.js";

export type RuntimeFactory = (options: RuntimeOptions) => AgentRuntime;

export interface MindObserver {
  onStateChanged?(agent: string, state: RuntimeState): void | Promise<void>;
  onTurnCompleted?(agent: string, event: { status: TurnStatus; finalText: string; error: string | null }): void | Promise<void>;
}

const PRIORITY_RANK: Record<InputPriority, number> = { now: 0, next: 1, later: 2 };

const SILENT_TURN_NOTICE = [
  "[bridge notice]",
  "Your last turn ended without any visible action. Nobody sees your turn output; people only see what you send with your tools.",
  "If a reply is due, send it now. If none is due, call dismiss with a short reason so the record shows you chose not to reply.",
].join("\n");

const MID_TURN_NOTE =
  "Note: this arrived while you were working. Continue your in-progress work and take this into account if it is relevant; if it is unrelated, handle it without abandoning what you were doing.";

// One named agent's mind. Every surface feeds the same durable inbox, and the inbox feeds one provider session.
export class AgentMind {
  private runtime: AgentRuntime | null = null;
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private visibleActionSinceWake = false;
  private noticeSentForWake = false;
  private awaitingVisibleAction = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = 5_000;

  constructor(
    readonly spec: AgentSpec,
    private readonly store: AgentStore,
    private readonly createRuntime: RuntimeFactory,
    private readonly instructions: string,
    private readonly tools: AgentTool[],
    private readonly observer: MindObserver = {},
  ) {}

  async start(): Promise<void> {
    this.ensureRuntime();
    await this.pump();
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.pumping?.catch(() => {});
    await this.runtime?.stop();
    this.runtime = null;
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
    await this.ensureRuntime().compact();
  }

  // Forget the provider session; the next input starts a fresh one. The inbox is untouched.
  async resetSession(): Promise<void> {
    await this.runtime?.stop();
    this.runtime = null;
    this.store.setAgentSession(this.spec.name, null);
  }

  private ensureRuntime(): AgentRuntime {
    if (this.runtime) return this.runtime;
    const events: RuntimeEvents = {
      onSessionChanged: (sessionId) => {
        this.store.setAgentSession(this.spec.name, sessionId);
      },
      onStateChanged: async (state) => {
        await this.observer.onStateChanged?.(this.spec.name, state);
        // Not awaited: this fires inside deliver(), which the pump itself is awaiting.
        if (state !== "running") void this.pump().catch(() => {});
      },
      onTurnCompleted: async (event) => {
        this.store.setAgentError(this.spec.name, event.status === "failed" ? event.error : null);
        await this.observer.onTurnCompleted?.(this.spec.name, event);
        await this.afterTurn(event.status);
      },
      onActivity: () => {},
      onProblem: (message) => {
        this.store.setAgentError(this.spec.name, message);
      },
      onCompaction: (event) => {
        logInfo("agent compaction", { agent: this.spec.name, status: event.status });
      },
    };
    this.runtime = this.createRuntime({
      spec: this.spec,
      sessionId: this.store.getAgentState(this.spec.name)?.sessionId ?? null,
      instructions: this.instructions,
      tools: this.tools,
      events,
    });
    return this.runtime;
  }

  private async afterTurn(status: TurnStatus): Promise<void> {
    if (!this.awaitingVisibleAction || status !== "completed") return;
    if (this.visibleActionSinceWake) {
      this.awaitingVisibleAction = false;
      return;
    }
    if (this.noticeSentForWake) {
      this.awaitingVisibleAction = false;
      return;
    }
    this.noticeSentForWake = true;
    await this.ensureRuntime().deliver({ text: SILENT_TURN_NOTICE, imagePaths: [], priority: "next" });
  }

  private pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      try {
        do {
          this.pumpAgain = false;
          await this.deliverQueued();
        } while (this.pumpAgain);
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump().catch(() => {});
    }, this.retryDelayMs);
    this.retryTimer.unref();
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 300_000);
  }

  // Context-only items wait in the inbox and ride along with the next item that wakes the agent.
  private async deliverQueued(): Promise<void> {
    const queued = this.store.listQueued(this.spec.name);
    if (!queued.some((item) => item.wake)) return;
    const runtime = this.ensureRuntime();
    const midTurn = runtime.state() === "running";
    try {
      await runtime.deliver({
        text: midTurn ? `${renderBatch(queued)}\n\n${MID_TURN_NOTE}` : renderBatch(queued),
        imagePaths: queued.flatMap((item) => item.imagePaths),
        priority: queued.reduce<InputPriority>((best, item) => (PRIORITY_RANK[item.priority] < PRIORITY_RANK[best] ? item.priority : best), "later"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setAgentError(this.spec.name, message);
      logError("agent delivery failed; input stays queued", { agent: this.spec.name, error: message, retryInMs: this.retryDelayMs });
      this.scheduleRetry();
      throw error;
    }
    this.retryDelayMs = 5_000;
    this.store.markDelivered(queued.map((item) => item.id));
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
    sections.push(`Earlier activity you can see, delivered for context (${context.length}):`, ...context.map((item) => item.text));
  }
  sections.push(waking.length === 1 ? "This woke you:" : `These woke you (${waking.length}):`, ...waking.map((item) => item.text));
  return sections.join("\n\n");
}
