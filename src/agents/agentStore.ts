import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InputPriority } from "./types.js";

export interface AgentStateRecord {
  name: string;
  sessionId: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface InboxItem {
  id: number;
  agent: string;
  // Identifies the source event so a redelivered Slack event is stored once.
  sourceKey: string;
  wake: boolean;
  priority: InputPriority;
  text: string;
  imagePaths: string[];
  // in_flight: handed to the runtime, not yet confirmed consumed by a finished turn.
  status: "queued" | "in_flight" | "delivered" | "failed";
  // Times this input has been handed to the runtime.
  attempts: number;
  // Turns that failed because of this input.
  faults: number;
  createdAt: string;
  deliveredAt: string | null;
}

export type WakeTrigger = { kind: "interval"; minutes: number } | { kind: "cron"; schedule: string; timezone: string };

export interface ScheduledWake {
  id: string;
  agent: string;
  trigger: WakeTrigger;
  // What the agent told itself to do when this fires.
  note: string;
  enabled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
}

export interface WebhookSource {
  source: string;
  routeToken: string;
  handlerPath: string;
  enabled: boolean;
  ownerAgent: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSubscription {
  id: string;
  agent: string;
  source: string;
  events: string[];
  // Every listed field must equal the event's field of the same name.
  match: Record<string, string>;
  note: string;
  enabled: boolean;
}

export interface NewInboxItem {
  agent: string;
  sourceKey: string;
  wake: boolean;
  priority: InputPriority;
  text: string;
  imagePaths: string[];
}

interface InboxRow {
  id: number;
  agent: string;
  source_key: string;
  wake: number;
  priority: string;
  text: string;
  image_paths_json: string;
  status: string;
  attempts: number;
  faults: number;
  created_at: string;
  delivered_at: string | null;
}

// Durable state for named agents: the provider session each mind resumes, and the inbox every surface feeds.
export class AgentStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        session_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        source_key TEXT NOT NULL,
        wake INTEGER NOT NULL,
        priority TEXT NOT NULL,
        text TEXT NOT NULL,
        image_paths_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(agent, source_key)
      );
      CREATE INDEX IF NOT EXISTS inbox_agent_status ON inbox(agent, status, id);
      CREATE TABLE IF NOT EXISTS thread_participation (
        agent TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(agent, channel_id, thread_ts)
      );
      CREATE TABLE IF NOT EXISTS scheduled_wakes (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        note TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_fired_at TEXT
      );
      CREATE TABLE IF NOT EXISTS webhook_sources (
        source TEXT PRIMARY KEY,
        route_token TEXT NOT NULL UNIQUE,
        handler_path TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        owner_agent TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        source TEXT NOT NULL,
        events_json TEXT NOT NULL,
        match_json TEXT NOT NULL,
        note TEXT NOT NULL,
        enabled INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_events (
        source TEXT NOT NULL,
        event TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(source, event, dedupe_key)
      );
      CREATE TABLE IF NOT EXISTS message_index (
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        ts TEXT NOT NULL,
        author TEXT NOT NULL,
        PRIMARY KEY(channel_id, ts)
      );
      CREATE TABLE IF NOT EXISTS agent_checks (
        agent TEXT PRIMARY KEY,
        last_checked_ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dm_sessions (
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        agent TEXT NOT NULL,
        PRIMARY KEY(channel_id, thread_ts)
      );
      CREATE TABLE IF NOT EXISTS conversation_seen (
        agent TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        last_ts TEXT NOT NULL,
        PRIMARY KEY(agent, channel_id, thread_key)
      );
    `);
    if (!(this.db.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>).some((column) => column.name === "attempts")) {
      this.db.exec("ALTER TABLE inbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    }
    if (!(this.db.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>).some((column) => column.name === "faults")) {
      this.db.exec("ALTER TABLE inbox ADD COLUMN faults INTEGER NOT NULL DEFAULT 0");
    }
  }

  close(): void {
    this.db.close();
  }

  getAgentState(name: string): AgentStateRecord | null {
    const row = this.db.prepare("SELECT name, session_id, last_error, updated_at FROM agents WHERE name = ?").get(name) as
      | { name: string; session_id: string | null; last_error: string | null; updated_at: string }
      | undefined;
    if (!row) return null;
    return { name: row.name, sessionId: row.session_id, lastError: row.last_error, updatedAt: row.updated_at };
  }

  setAgentSession(name: string, sessionId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO agents (name, session_id, last_error, updated_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(name) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(name, sessionId, new Date().toISOString());
  }

  setAgentError(name: string, lastError: string | null): void {
    this.db
      .prepare(
        `INSERT INTO agents (name, session_id, last_error, updated_at) VALUES (?, NULL, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(name, lastError, new Date().toISOString());
  }

  // Returns null when this source event is already in the agent's inbox.
  enqueue(item: NewInboxItem): InboxItem | null {
    const result = this.db
      .prepare(
        `INSERT INTO inbox (agent, source_key, wake, priority, text, image_paths_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
         ON CONFLICT(agent, source_key) DO NOTHING`,
      )
      .run(item.agent, item.sourceKey, item.wake ? 1 : 0, item.priority, item.text, JSON.stringify(item.imagePaths), new Date().toISOString());
    if (result.changes === 0) return null;
    return this.getInboxItem(Number(result.lastInsertRowid));
  }

  hasSource(agent: string, sourceKey: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM inbox WHERE agent = ? AND source_key = ?").get(agent, sourceKey));
  }

  getInboxItem(id: number): InboxItem | null {
    const row = this.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxRow | undefined;
    return row ? mapInboxRow(row) : null;
  }

  listQueued(agent: string): InboxItem[] {
    const rows = this.db.prepare("SELECT * FROM inbox WHERE agent = ? AND status = 'queued' ORDER BY id").all(agent) as unknown as InboxRow[];
    return rows.map(mapInboxRow);
  }

  markInFlight(ids: number[]): void {
    const statement = this.db.prepare("UPDATE inbox SET status = 'in_flight', attempts = attempts + 1 WHERE id = ?");
    for (const id of ids) statement.run(id);
  }

  // The hand-off to the runtime failed, so the agent never saw these; this does not count as a delivery.
  returnUndelivered(ids: number[]): void {
    const statement = this.db.prepare("UPDATE inbox SET status = 'queued', attempts = MAX(attempts - 1, 0) WHERE id = ? AND status = 'in_flight'");
    for (const id of ids) statement.run(id);
  }

  // A finished turn took these inputs in.
  markDelivered(ids: number[]): void {
    const statement = this.db.prepare("UPDATE inbox SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'in_flight'");
    const now = new Date().toISOString();
    for (const id of ids) statement.run(now, id);
  }

  // A turn that took these inputs failed. They go back in the queue. When the input itself caused the failure it counts
  // as a fault, and an input with maxFaults faults is given up on. Returns the rows given up on.
  requeue(ids: number[], countFault: boolean, maxFaults: number): InboxItem[] {
    const abandoned: InboxItem[] = [];
    for (const id of ids) {
      const row = this.getInboxItem(id);
      if (!row || row.status !== "in_flight") continue;
      const faults = row.faults + (countFault ? 1 : 0);
      const status = faults >= maxFaults ? "failed" : "queued";
      this.db.prepare("UPDATE inbox SET status = ?, faults = ? WHERE id = ?").run(status, faults, id);
      if (status === "failed") abandoned.push({ ...row, status, faults });
    }
    return abandoned;
  }

  // The runtime went away without reporting on these; nothing suggests the input was at fault.
  requeueAllInFlight(agent: string): number {
    return Number(this.db.prepare("UPDATE inbox SET status = 'queued' WHERE agent = ? AND status = 'in_flight'").run(agent).changes);
  }

  // Marks a source event as handled without delivering it (operator commands), so a redelivery is ignored.
  recordHandled(agent: string, sourceKey: string, text: string): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `INSERT INTO inbox (agent, source_key, wake, priority, text, image_paths_json, status, created_at, delivered_at)
           VALUES (?, ?, 0, 'later', ?, '[]', 'delivered', ?, ?) ON CONFLICT(agent, source_key) DO NOTHING`,
        )
        .run(agent, sourceKey, text, now, now).changes > 0
    );
  }

  createScheduledWake(wake: Pick<ScheduledWake, "id" | "agent" | "trigger" | "note">): ScheduledWake {
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO scheduled_wakes (id, agent, trigger_json, note, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(wake.id, wake.agent, JSON.stringify(wake.trigger), wake.note, createdAt);
    return { ...wake, enabled: true, createdAt, lastFiredAt: null };
  }

  listScheduledWakes(agent?: string): ScheduledWake[] {
    const rows = (agent
      ? this.db.prepare("SELECT * FROM scheduled_wakes WHERE agent = ? ORDER BY created_at").all(agent)
      : this.db.prepare("SELECT * FROM scheduled_wakes ORDER BY created_at").all()) as unknown as Array<{
      id: string;
      agent: string;
      trigger_json: string;
      note: string;
      enabled: number;
      created_at: string;
      last_fired_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      trigger: JSON.parse(row.trigger_json) as WakeTrigger,
      note: row.note,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastFiredAt: row.last_fired_at,
    }));
  }

  markScheduledWakeFired(id: string, firedAt: string): void {
    this.db.prepare("UPDATE scheduled_wakes SET last_fired_at = ? WHERE id = ?").run(firedAt, id);
  }

  // Returns false when the wake does not exist or belongs to another agent.
  disableScheduledWake(agent: string, id: string): boolean {
    return this.db.prepare("UPDATE scheduled_wakes SET enabled = 0 WHERE id = ? AND agent = ?").run(id, agent).changes > 0;
  }

  createWebhookSource(input: Pick<WebhookSource, "source" | "routeToken" | "handlerPath" | "ownerAgent">): WebhookSource {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO webhook_sources (source, route_token, handler_path, enabled, owner_agent, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)")
      .run(input.source, input.routeToken, input.handlerPath, input.ownerAgent, now, now);
    return this.getWebhookSource(input.source)!;
  }

  getWebhookSource(source: string): WebhookSource | null {
    const row = this.db.prepare("SELECT * FROM webhook_sources WHERE source = ?").get(source) as WebhookSourceRow | undefined;
    return row ? mapWebhookSource(row) : null;
  }

  getWebhookSourceByRouteToken(routeToken: string): WebhookSource | null {
    const row = this.db.prepare("SELECT * FROM webhook_sources WHERE route_token = ?").get(routeToken) as WebhookSourceRow | undefined;
    return row ? mapWebhookSource(row) : null;
  }

  listWebhookSources(): WebhookSource[] {
    return (this.db.prepare("SELECT * FROM webhook_sources ORDER BY source").all() as unknown as WebhookSourceRow[]).map(mapWebhookSource);
  }

  // Only the agent that created a source may change it.
  updateWebhookSource(source: string, ownerAgent: string, patch: { enabled?: boolean; routeToken?: string }): WebhookSource | null {
    const current = this.getWebhookSource(source);
    if (!current || current.ownerAgent !== ownerAgent) return null;
    this.db
      .prepare("UPDATE webhook_sources SET enabled = ?, route_token = ?, updated_at = ? WHERE source = ?")
      .run((patch.enabled ?? current.enabled) ? 1 : 0, patch.routeToken ?? current.routeToken, new Date().toISOString(), source);
    return this.getWebhookSource(source);
  }

  createWebhookSubscription(input: Omit<WebhookSubscription, "enabled">): WebhookSubscription {
    this.db
      .prepare("INSERT INTO webhook_subscriptions (id, agent, source, events_json, match_json, note, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)")
      .run(input.id, input.agent, input.source, JSON.stringify(input.events), JSON.stringify(input.match), input.note);
    return { ...input, enabled: true };
  }

  listWebhookSubscriptions(filter: { agent?: string; source?: string } = {}): WebhookSubscription[] {
    const rows = this.db.prepare("SELECT * FROM webhook_subscriptions ORDER BY id").all() as unknown as Array<{
      id: string;
      agent: string;
      source: string;
      events_json: string;
      match_json: string;
      note: string;
      enabled: number;
    }>;
    return rows
      .filter((row) => (!filter.agent || row.agent === filter.agent) && (!filter.source || row.source === filter.source))
      .map((row) => ({
        id: row.id,
        agent: row.agent,
        source: row.source,
        events: JSON.parse(row.events_json) as string[],
        match: JSON.parse(row.match_json) as Record<string, string>,
        note: row.note,
        enabled: row.enabled === 1,
      }));
  }

  disableWebhookSubscription(agent: string, id: string): boolean {
    return this.db.prepare("UPDATE webhook_subscriptions SET enabled = 0 WHERE id = ? AND agent = ?").run(id, agent).changes > 0;
  }

  // Returns false when this event was already recorded, so a redelivered webhook wakes nobody twice.
  recordWebhookEvent(source: string, event: string, dedupeKey: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO webhook_events (source, event, dedupe_key, received_at) VALUES (?, ?, ?, ?)")
        .run(source, event, dedupeKey, new Date().toISOString()).changes > 0
    );
  }

  forgetWebhookEvent(source: string, event: string, dedupeKey: string): void {
    this.db.prepare("DELETE FROM webhook_events WHERE source = ? AND event = ? AND dedupe_key = ?").run(source, event, dedupeKey);
  }

  recordThreadParticipation(agent: string, channelId: string, threadTs: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO thread_participation (agent, channel_id, thread_ts, created_at) VALUES (?, ?, ?, ?)")
      .run(agent, channelId, threadTs, new Date().toISOString());
  }

  // How far the agent has read in a conversation (a thread's root ts, or "top" for the channel's main line). A wake brings
  // whatever came after this point, the way a person catches up from their last-read marker.
  markSeen(agent: string, channelId: string, threadKey: string, ts: string): void {
    this.db
      .prepare(
        `INSERT INTO conversation_seen (agent, channel_id, thread_key, last_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent, channel_id, thread_key) DO UPDATE SET last_ts = excluded.last_ts WHERE excluded.last_ts > conversation_seen.last_ts`,
      )
      .run(agent, channelId, threadKey, ts);
  }

  // Who said something where and when, with no words kept. It is what lets an agent ask what is new without reading it.
  indexMessage(entry: { channelId: string; channelType: string; threadKey: string; ts: string; author: string }): void {
    this.db
      .prepare("INSERT OR IGNORE INTO message_index (channel_id, channel_type, thread_key, ts, author) VALUES (?, ?, ?, ?, ?)")
      .run(entry.channelId, entry.channelType, entry.threadKey, entry.ts, entry.author);
  }

  pruneMessageIndex(olderThanTs: string): void {
    this.db.prepare("DELETE FROM message_index WHERE ts < ?").run(olderThanTs);
  }

  // Activity since the agent last asked, or last read that conversation, whichever is later. Asking clears the badges.
  whatsNew(agent: string, nowTs: string, limit: number): ActivitySummary[] {
    const lastChecked = (this.db.prepare("SELECT last_checked_ts FROM agent_checks WHERE agent = ?").get(agent) as { last_checked_ts: string } | undefined)?.last_checked_ts ?? "0";
    const rows = this.db
      .prepare(
        `SELECT m.channel_id AS channelId, m.channel_type AS channelType, m.thread_key AS threadKey, COUNT(*) AS count, MAX(m.ts) AS lastTs, GROUP_CONCAT(DISTINCT m.author) AS authors
         FROM message_index m
         LEFT JOIN conversation_seen s ON s.agent = ? AND s.channel_id = m.channel_id AND s.thread_key = m.thread_key
         LEFT JOIN dm_sessions d ON d.channel_id = m.channel_id AND d.thread_ts = m.thread_key
         WHERE m.author != ? AND m.ts > ? AND m.ts > COALESCE(s.last_ts, '0')
           AND (m.channel_type != 'im' OR d.agent = ?)
         GROUP BY m.channel_id, m.thread_key ORDER BY lastTs DESC LIMIT ?`,
      )
      .all(agent, agent, lastChecked, agent, limit) as unknown as Array<Omit<ActivitySummary, "authors"> & { authors: string }>;
    this.db
      .prepare("INSERT INTO agent_checks (agent, last_checked_ts) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET last_checked_ts = excluded.last_checked_ts")
      .run(agent, nowTs);
    return rows.map((row) => ({ ...row, count: Number(row.count), authors: row.authors.split(",") }));
  }

  // A thread in the app's direct message belongs to one agent; the others can neither hear it nor read it.
  dmOwner(channelId: string, threadTs: string): string | null {
    return (this.db.prepare("SELECT agent FROM dm_sessions WHERE channel_id = ? AND thread_ts = ?").get(channelId, threadTs) as { agent: string } | undefined)?.agent ?? null;
  }

  claimDmSession(channelId: string, threadTs: string, agent: string): string {
    this.db.prepare("INSERT OR IGNORE INTO dm_sessions (channel_id, thread_ts, agent) VALUES (?, ?, ?)").run(channelId, threadTs, agent);
    return this.dmOwner(channelId, threadTs)!;
  }

  dmSessions(agent: string, channelId: string): string[] {
    return (this.db.prepare("SELECT thread_ts FROM dm_sessions WHERE agent = ? AND channel_id = ? ORDER BY thread_ts DESC LIMIT 50").all(agent, channelId) as Array<{ thread_ts: string }>).map((row) => row.thread_ts);
  }

  clearSeen(agent: string): void {
    this.db.prepare("DELETE FROM conversation_seen WHERE agent = ?").run(agent);
  }

  lastSeen(agent: string, channelId: string, threadKey: string): string | null {
    const row = this.db.prepare("SELECT last_ts FROM conversation_seen WHERE agent = ? AND channel_id = ? AND thread_key = ?").get(agent, channelId, threadKey) as { last_ts: string } | undefined;
    return row?.last_ts ?? null;
  }

  isThreadParticipant(agent: string, channelId: string, threadTs: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM thread_participation WHERE agent = ? AND channel_id = ? AND thread_ts = ?").get(agent, channelId, threadTs),
    );
  }
}

export interface ActivitySummary {
  channelId: string;
  channelType: string;
  // A thread's root ts, or "top" for the conversation's main line.
  threadKey: string;
  count: number;
  lastTs: string;
  authors: string[];
}

interface WebhookSourceRow {
  source: string;
  route_token: string;
  handler_path: string;
  enabled: number;
  owner_agent: string;
  created_at: string;
  updated_at: string;
}

function mapWebhookSource(row: WebhookSourceRow): WebhookSource {
  return {
    source: row.source,
    routeToken: row.route_token,
    handlerPath: row.handler_path,
    enabled: row.enabled === 1,
    ownerAgent: row.owner_agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInboxRow(row: InboxRow): InboxItem {
  return {
    id: row.id,
    agent: row.agent,
    sourceKey: row.source_key,
    wake: row.wake === 1,
    priority: row.priority as InputPriority,
    text: row.text,
    imagePaths: JSON.parse(row.image_paths_json) as string[],
    status: row.status as InboxItem["status"],
    attempts: row.attempts,
    faults: row.faults,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}
