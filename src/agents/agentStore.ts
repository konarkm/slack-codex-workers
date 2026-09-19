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
  status: "queued" | "delivered";
  createdAt: string;
  deliveredAt: string | null;
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
      CREATE TABLE IF NOT EXISTS thread_seen (
        agent TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        PRIMARY KEY(agent, channel_id, thread_ts)
      );
    `);
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

  markDelivered(ids: number[]): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare("UPDATE inbox SET status = 'delivered', delivered_at = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const id of ids) statement.run(now, id);
  }

  recordThreadParticipation(agent: string, channelId: string, threadTs: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO thread_participation (agent, channel_id, thread_ts, created_at) VALUES (?, ?, ?, ?)")
      .run(agent, channelId, threadTs, new Date().toISOString());
  }

  // A thread is seen once any of its messages has reached the agent, so its history is already in the agent's context.
  markThreadSeen(agent: string, channelId: string, threadTs: string): void {
    this.db.prepare("INSERT OR IGNORE INTO thread_seen (agent, channel_id, thread_ts) VALUES (?, ?, ?)").run(agent, channelId, threadTs);
  }

  hasSeenThread(agent: string, channelId: string, threadTs: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM thread_seen WHERE agent = ? AND channel_id = ? AND thread_ts = ?").get(agent, channelId, threadTs));
  }

  isThreadParticipant(agent: string, channelId: string, threadTs: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM thread_participation WHERE agent = ? AND channel_id = ? AND thread_ts = ?").get(agent, channelId, threadTs),
    );
  }
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
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}
