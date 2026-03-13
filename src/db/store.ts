import Database from "better-sqlite3";
import type { ChannelRecord, DmSessionRecord, RuntimeSettings, TeamDefaults, WorkerRecord } from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function parseSettings(value: string | null | undefined): RuntimeSettings {
  if (!value) {
    return { model: null, effort: null };
  }
  try {
    const parsed = JSON.parse(value) as Partial<RuntimeSettings>;
    return {
      model: typeof parsed.model === "string" ? parsed.model : null,
      effort: typeof parsed.effort === "string" ? parsed.effort as RuntimeSettings["effort"] : null,
    };
  } catch {
    return { model: null, effort: null };
  }
}

export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workers (
        key TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        root_ts TEXT NOT NULL,
        app_thread_id TEXT NOT NULL,
        active_turn_id TEXT,
        owner_user_id TEXT NOT NULL,
        root_owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_agent_slack_ts TEXT,
        current_agent_item_id TEXT,
        current_worklog_slack_ts TEXT,
        settings_json TEXT NOT NULL,
        parent_worker_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, channel_id, root_ts)
      );

      CREATE TABLE IF NOT EXISTS dm_sessions (
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        app_thread_id TEXT,
        active_turn_id TEXT,
        current_agent_slack_ts TEXT,
        current_agent_item_id TEXT,
        current_worklog_slack_ts TEXT,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(team_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS channel_cache (
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_private INTEGER NOT NULL,
        is_member INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(team_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS processed_messages (
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(team_id, channel_id, message_ts, kind)
      );
    `);

    const dmSessionColumns = this.db.prepare("PRAGMA table_info(dm_sessions)").all() as Array<{ name?: string }>;
    const hasChannelId = dmSessionColumns.some((column) => column.name === "channel_id");
    if (!hasChannelId) {
      this.db.exec("ALTER TABLE dm_sessions ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
    }
  }

  getWorker(teamId: string, channelId: string, rootTs: string): WorkerRecord | null {
    const row = this.db
      .prepare("SELECT * FROM workers WHERE team_id = ? AND channel_id = ? AND root_ts = ?")
      .get(teamId, channelId, rootTs) as Record<string, unknown> | undefined;
    return row ? this.toWorker(row) : null;
  }

  getWorkerByAppThreadId(appThreadId: string): WorkerRecord | null {
    const row = this.db
      .prepare("SELECT * FROM workers WHERE app_thread_id = ?")
      .get(appThreadId) as Record<string, unknown> | undefined;
    return row ? this.toWorker(row) : null;
  }

  upsertWorker(input: Omit<WorkerRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): WorkerRecord {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO workers (
        key, team_id, channel_id, root_ts, app_thread_id, active_turn_id, owner_user_id, root_owner_user_id,
        status, current_agent_slack_ts, current_agent_item_id, current_worklog_slack_ts, settings_json,
        parent_worker_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, channel_id, root_ts) DO UPDATE SET
        app_thread_id=excluded.app_thread_id,
        active_turn_id=excluded.active_turn_id,
        owner_user_id=excluded.owner_user_id,
        root_owner_user_id=excluded.root_owner_user_id,
        status=excluded.status,
        current_agent_slack_ts=excluded.current_agent_slack_ts,
        current_agent_item_id=excluded.current_agent_item_id,
        current_worklog_slack_ts=excluded.current_worklog_slack_ts,
        settings_json=excluded.settings_json,
        parent_worker_key=excluded.parent_worker_key,
        updated_at=excluded.updated_at
    `).run(
      input.key,
      input.teamId,
      input.channelId,
      input.rootTs,
      input.appThreadId,
      input.activeTurnId,
      input.ownerUserId,
      input.rootOwnerUserId,
      input.status,
      input.currentAgentSlackTs,
      input.currentAgentItemId,
      input.currentWorklogSlackTs,
      JSON.stringify(input.settings),
      input.parentWorkerKey,
      createdAt,
      updatedAt,
    );
    return this.getWorker(input.teamId, input.channelId, input.rootTs)!;
  }

  updateWorkerState(
    key: string,
    patch: Partial<Pick<WorkerRecord, "activeTurnId" | "status" | "currentAgentSlackTs" | "currentAgentItemId" | "currentWorklogSlackTs" | "settings">>,
  ): void {
    const current = this.db.prepare("SELECT * FROM workers WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    if (!current) return;
    const worker = this.toWorker(current);
    this.db.prepare(`
      UPDATE workers SET
        active_turn_id = ?,
        status = ?,
        current_agent_slack_ts = ?,
        current_agent_item_id = ?,
        current_worklog_slack_ts = ?,
        settings_json = ?,
        updated_at = ?
      WHERE key = ?
    `).run(
      patch.activeTurnId ?? worker.activeTurnId,
      patch.status ?? worker.status,
      patch.currentAgentSlackTs ?? worker.currentAgentSlackTs,
      patch.currentAgentItemId ?? worker.currentAgentItemId,
      patch.currentWorklogSlackTs ?? worker.currentWorklogSlackTs,
      JSON.stringify(patch.settings ?? worker.settings),
      nowIso(),
      key,
    );
  }

  listActiveWorkers(): WorkerRecord[] {
    const rows = this.db.prepare("SELECT * FROM workers WHERE active_turn_id IS NOT NULL").all() as Record<string, unknown>[];
    return rows.map((row) => this.toWorker(row));
  }

  hasProcessedMessage(teamId: string, channelId: string, messageTs: string, kind: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM processed_messages WHERE team_id = ? AND channel_id = ? AND message_ts = ? AND kind = ?")
      .get(teamId, channelId, messageTs, kind) as Record<string, unknown> | undefined;
    return Boolean(row);
  }

  markProcessedMessage(teamId: string, channelId: string, messageTs: string, kind: string): void {
    this.db.prepare(`
      INSERT INTO processed_messages (team_id, channel_id, message_ts, kind, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id, channel_id, message_ts, kind) DO NOTHING
    `).run(teamId, channelId, messageTs, kind, nowIso());
  }

  getDmSession(teamId: string, userId: string): DmSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM dm_sessions WHERE team_id = ? AND user_id = ?").get(teamId, userId) as Record<string, unknown> | undefined;
    return row ? this.toDmSession(row) : null;
  }

  upsertDmSession(input: Omit<DmSessionRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): DmSessionRecord {
    const current = this.getDmSession(input.teamId, input.userId);
    const createdAt = current?.createdAt ?? input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO dm_sessions (
        team_id, user_id, channel_id, app_thread_id, active_turn_id, current_agent_slack_ts, current_agent_item_id,
        current_worklog_slack_ts, settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, user_id) DO UPDATE SET
        channel_id=excluded.channel_id,
        app_thread_id=excluded.app_thread_id,
        active_turn_id=excluded.active_turn_id,
        current_agent_slack_ts=excluded.current_agent_slack_ts,
        current_agent_item_id=excluded.current_agent_item_id,
        current_worklog_slack_ts=excluded.current_worklog_slack_ts,
        settings_json=excluded.settings_json,
        updated_at=excluded.updated_at
    `).run(
      input.teamId,
      input.userId,
      input.channelId,
      input.appThreadId,
      input.activeTurnId,
      input.currentAgentSlackTs,
      input.currentAgentItemId,
      input.currentWorklogSlackTs,
      JSON.stringify(input.settings),
      createdAt,
      updatedAt,
    );
    return this.getDmSession(input.teamId, input.userId)!;
  }

  getTeamDefaults(teamId: string): TeamDefaults {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(`defaults:${teamId}`) as { value?: string } | undefined;
    if (!row?.value) {
      return { model: null, effort: null };
    }
    try {
      const parsed = JSON.parse(row.value) as Partial<TeamDefaults>;
      return {
        model: typeof parsed.model === "string" ? parsed.model : null,
        effort: typeof parsed.effort === "string" ? parsed.effort as TeamDefaults["effort"] : null,
      };
    } catch {
      return { model: null, effort: null };
    }
  }

  setTeamDefaults(teamId: string, defaults: TeamDefaults): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(`defaults:${teamId}`, JSON.stringify(defaults));
  }

  upsertChannels(channels: ChannelRecord[]): void {
    const statement = this.db.prepare(`
      INSERT INTO channel_cache (team_id, channel_id, name, is_private, is_member, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, channel_id) DO UPDATE SET
        name=excluded.name,
        is_private=excluded.is_private,
        is_member=excluded.is_member,
        updated_at=excluded.updated_at
    `);
    const transaction = this.db.transaction((rows: ChannelRecord[]) => {
      for (const row of rows) {
        statement.run(row.teamId, row.channelId, row.name, row.isPrivate ? 1 : 0, row.isMember ? 1 : 0, row.updatedAt);
      }
    });
    transaction(channels);
  }

  listChannels(teamId: string, query?: string): ChannelRecord[] {
    if (query && query.trim()) {
      const like = `%${query.toLowerCase()}%`;
      const rows = this.db.prepare(`
        SELECT * FROM channel_cache
        WHERE team_id = ? AND lower(name) LIKE ?
        ORDER BY name ASC
      `).all(teamId, like) as Record<string, unknown>[];
      return rows.map((row) => this.toChannel(row));
    }
    const rows = this.db.prepare("SELECT * FROM channel_cache WHERE team_id = ? ORDER BY name ASC").all(teamId) as Record<string, unknown>[];
    return rows.map((row) => this.toChannel(row));
  }

  private toWorker(row: Record<string, unknown>): WorkerRecord {
    return {
      key: String(row.key),
      teamId: String(row.team_id),
      channelId: String(row.channel_id),
      rootTs: String(row.root_ts),
      appThreadId: String(row.app_thread_id),
      activeTurnId: row.active_turn_id ? String(row.active_turn_id) : null,
      ownerUserId: String(row.owner_user_id),
      rootOwnerUserId: String(row.root_owner_user_id),
      status: String(row.status),
      currentAgentSlackTs: row.current_agent_slack_ts ? String(row.current_agent_slack_ts) : null,
      currentAgentItemId: row.current_agent_item_id ? String(row.current_agent_item_id) : null,
      currentWorklogSlackTs: row.current_worklog_slack_ts ? String(row.current_worklog_slack_ts) : null,
      settings: parseSettings(typeof row.settings_json === "string" ? row.settings_json : null),
      parentWorkerKey: row.parent_worker_key ? String(row.parent_worker_key) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toDmSession(row: Record<string, unknown>): DmSessionRecord {
    return {
      teamId: String(row.team_id),
      userId: String(row.user_id),
      channelId: String(row.channel_id ?? ""),
      appThreadId: row.app_thread_id ? String(row.app_thread_id) : null,
      activeTurnId: row.active_turn_id ? String(row.active_turn_id) : null,
      currentAgentSlackTs: row.current_agent_slack_ts ? String(row.current_agent_slack_ts) : null,
      currentAgentItemId: row.current_agent_item_id ? String(row.current_agent_item_id) : null,
      currentWorklogSlackTs: row.current_worklog_slack_ts ? String(row.current_worklog_slack_ts) : null,
      settings: parseSettings(typeof row.settings_json === "string" ? row.settings_json : null),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toChannel(row: Record<string, unknown>): ChannelRecord {
    return {
      teamId: String(row.team_id),
      channelId: String(row.channel_id),
      name: String(row.name),
      isPrivate: Boolean(row.is_private),
      isMember: Boolean(row.is_member),
      updatedAt: String(row.updated_at),
    };
  }
}
