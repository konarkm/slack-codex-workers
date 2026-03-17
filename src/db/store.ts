import Database from "better-sqlite3";
import { DEFAULT_RUNTIME_SETTINGS } from "../config.js";
import type {
  ChannelRecord,
  DmSessionRecord,
  InboundMessageKind,
  InboundMessageRecord,
  InboundMessageStatus,
  MessageAttachmentRecord,
  PendingWakeRecord,
  PendingWorkerShellRecord,
  PendingRestartRecord,
  PendingRequestState,
  PendingWorkerShellSource,
  RegistrationAction,
  RegistrationRecord,
  RegistrationTarget,
  RegistrationTrigger,
  RuntimeSettings,
  SessionStatus,
  TeamDefaults,
  WorkstreamRecord,
  WorkerIdentity,
  WorkerRecord,
} from "../types.js";

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

function parsePendingRequest(value: string | null | undefined): PendingRequestState | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as PendingRequestState;
  } catch {
    return null;
  }
}

function parseIdentity(value: string | null | undefined): WorkerIdentity | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkerIdentity>;
    if (typeof parsed.username !== "string" || !parsed.username.trim()) return null;
    if (typeof parsed.iconEmoji !== "string" || !parsed.iconEmoji.trim()) return null;
    return {
      username: parsed.username,
      iconEmoji: parsed.iconEmoji,
    };
  } catch {
    return null;
  }
}

function parsePendingWorkerShellSource(value: string | null | undefined): PendingWorkerShellSource {
  if (!value) return { sourceKind: "unknown", sourceSummary: "unknown" };
  try {
    const parsed = JSON.parse(value) as Partial<PendingWorkerShellSource>;
    return {
      sourceKind: typeof parsed.sourceKind === "string" ? parsed.sourceKind : "unknown",
      sourceSummary: typeof parsed.sourceSummary === "string" ? parsed.sourceSummary : "unknown",
      sourceSlackChannelId: typeof parsed.sourceSlackChannelId === "string" ? parsed.sourceSlackChannelId : null,
      sourceSlackMessageTs: typeof parsed.sourceSlackMessageTs === "string" ? parsed.sourceSlackMessageTs : null,
      fromAddress: typeof parsed.fromAddress === "string" ? parsed.fromAddress : null,
      toAddress: typeof parsed.toAddress === "string" ? parsed.toAddress : null,
    };
  } catch {
    return { sourceKind: "unknown", sourceSummary: "unknown" };
  }
}

function parseRegistrationTarget(value: string | null | undefined): RegistrationTarget {
  if (!value) {
    return {
      kind: "workstream",
      workstreamId: "",
      workerKey: null,
    };
  }
  try {
    const parsed = JSON.parse(value) as Partial<RegistrationTarget>;
    return {
      kind: parsed.kind === "worker" ? "worker" : "workstream",
      workstreamId: typeof parsed.workstreamId === "string" ? parsed.workstreamId : "",
      workerKey: typeof parsed.workerKey === "string" ? parsed.workerKey : null,
    };
  } catch {
    return {
      kind: "workstream",
      workstreamId: "",
      workerKey: null,
    };
  }
}

function parseRegistrationAction(value: string | null | undefined): RegistrationAction {
  if (!value) {
    return { kind: "spawn" };
  }
  try {
    const parsed = JSON.parse(value) as Partial<RegistrationAction>;
    return { kind: parsed.kind === "wake_self" ? "wake_self" : "spawn" };
  } catch {
    return { kind: "spawn" };
  }
}

function parseRegistrationTrigger(value: string | null | undefined): RegistrationTrigger {
  if (!value) {
    return { kind: "cron", schedule: "", timezone: "UTC" };
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const kind = parsed.kind;
    if (kind === "heartbeat") {
      return {
        kind: "heartbeat",
        intervalMinutes: Number(parsed.intervalMinutes ?? 0),
      };
    }
    if (kind === "webhook") {
      const match = parsed.match && typeof parsed.match === "object" && !Array.isArray(parsed.match)
        ? Object.fromEntries(
            Object.entries(parsed.match).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : null;
      return {
        kind: "webhook",
        source: typeof parsed.source === "string" ? parsed.source : "",
        events: Array.isArray(parsed.events) ? parsed.events.filter((entry): entry is string => typeof entry === "string") : [],
        match,
      };
    }
    return {
      kind: "cron",
      schedule: typeof parsed.schedule === "string" ? parsed.schedule : "",
      timezone: typeof parsed.timezone === "string" ? parsed.timezone : "UTC",
    };
  } catch {
    return { kind: "cron", schedule: "", timezone: "UTC" };
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
        workstream_id TEXT,
        app_thread_id TEXT NOT NULL,
        active_turn_id TEXT,
        owner_user_id TEXT NOT NULL,
        root_owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_agent_slack_ts TEXT,
        current_agent_item_id TEXT,
        current_worklog_slack_ts TEXT,
        settings_json TEXT NOT NULL,
        identity_json TEXT,
        parent_worker_key TEXT,
        request_item_id TEXT,
        request_item_path TEXT,
        last_error TEXT,
        last_inbound_message_ts TEXT,
        pending_request_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, channel_id, root_ts)
      );

      CREATE TABLE IF NOT EXISTS workstreams (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, relative_path),
        UNIQUE(team_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS registrations (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL,
        worker_key TEXT,
        owner_user_id TEXT NOT NULL DEFAULT '',
        root_owner_user_id TEXT NOT NULL DEFAULT '',
        description TEXT,
        enabled INTEGER NOT NULL,
        target_json TEXT NOT NULL,
        action_json TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_wakes (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        registration_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL,
        worker_key TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_path TEXT,
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_worker_shells (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        root_ts TEXT,
        title TEXT NOT NULL,
        request_item_id TEXT,
        request_item_path TEXT,
        owner_user_id TEXT NOT NULL,
        root_owner_user_id TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        identity_json TEXT,
        parent_worker_key TEXT,
        source_json TEXT NOT NULL,
        status TEXT NOT NULL,
        app_thread_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dm_sessions (
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        app_thread_id TEXT,
        active_turn_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        current_agent_slack_ts TEXT,
        current_agent_item_id TEXT,
        current_worklog_slack_ts TEXT,
        settings_json TEXT NOT NULL,
        last_error TEXT,
        last_inbound_message_ts TEXT,
        pending_request_json TEXT,
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

      CREATE TABLE IF NOT EXISTS inbound_messages (
        key TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        root_ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        retryable INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        worker_key TEXT,
        app_thread_id TEXT,
        turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(team_id, channel_id, message_ts, kind)
      );

      CREATE TABLE IF NOT EXISTS message_attachments (
        key TEXT PRIMARY KEY,
        message_key TEXT NOT NULL,
        slack_file_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mimetype TEXT NOT NULL,
        local_path TEXT NOT NULL,
        is_image INTEGER NOT NULL,
        size_bytes INTEGER,
        status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(message_key, slack_file_id)
      );
    `);

    this.ensureColumn("workers", "last_error", "TEXT");
    this.ensureColumn("workers", "last_inbound_message_ts", "TEXT");
    this.ensureColumn("workers", "pending_request_json", "TEXT");
    this.ensureColumn("workers", "identity_json", "TEXT");
    this.ensureColumn("workers", "workstream_id", "TEXT");
    this.ensureColumn("workers", "request_item_id", "TEXT");
    this.ensureColumn("workers", "request_item_path", "TEXT");
    this.ensureColumn("registrations", "owner_user_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("registrations", "root_owner_user_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("dm_sessions", "channel_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("dm_sessions", "status", "TEXT NOT NULL DEFAULT 'idle'");
    this.ensureColumn("dm_sessions", "last_error", "TEXT");
    this.ensureColumn("dm_sessions", "last_inbound_message_ts", "TEXT");
    this.ensureColumn("dm_sessions", "pending_request_json", "TEXT");
    this.ensureColumn("inbound_messages", "retryable", "INTEGER NOT NULL DEFAULT 1");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    const hasColumn = columns.some((entry) => entry.name === column);
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

  getWorkerByKey(key: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT * FROM workers WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    return row ? this.toWorker(row) : null;
  }

  listWorkers(): WorkerRecord[] {
    const rows = this.db.prepare("SELECT * FROM workers ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.toWorker(row));
  }

  listWorkersWithActiveTurns(): WorkerRecord[] {
    const rows = this.db.prepare("SELECT * FROM workers WHERE active_turn_id IS NOT NULL ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.toWorker(row));
  }

  upsertWorker(input: Omit<WorkerRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): WorkerRecord {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO workers (
        key, team_id, channel_id, root_ts, workstream_id, app_thread_id, active_turn_id, owner_user_id, root_owner_user_id,
        status, current_agent_slack_ts, current_agent_item_id, current_worklog_slack_ts, settings_json, identity_json,
        parent_worker_key, request_item_id, request_item_path, last_error, last_inbound_message_ts, pending_request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, channel_id, root_ts) DO UPDATE SET
        workstream_id=excluded.workstream_id,
        app_thread_id=excluded.app_thread_id,
        active_turn_id=excluded.active_turn_id,
        owner_user_id=excluded.owner_user_id,
        root_owner_user_id=excluded.root_owner_user_id,
        status=excluded.status,
        current_agent_slack_ts=excluded.current_agent_slack_ts,
        current_agent_item_id=excluded.current_agent_item_id,
        current_worklog_slack_ts=excluded.current_worklog_slack_ts,
        settings_json=excluded.settings_json,
        identity_json=excluded.identity_json,
        parent_worker_key=excluded.parent_worker_key,
      request_item_id=excluded.request_item_id,
      request_item_path=excluded.request_item_path,
        last_error=excluded.last_error,
        last_inbound_message_ts=excluded.last_inbound_message_ts,
        pending_request_json=excluded.pending_request_json,
        updated_at=excluded.updated_at
    `).run(
      input.key,
      input.teamId,
      input.channelId,
      input.rootTs,
      input.workstreamId,
      input.appThreadId,
      input.activeTurnId,
      input.ownerUserId,
      input.rootOwnerUserId,
      input.status,
      input.currentAgentSlackTs,
      input.currentAgentItemId,
      input.currentWorklogSlackTs,
      JSON.stringify(input.settings),
      input.identity ? JSON.stringify(input.identity) : null,
      input.parentWorkerKey,
      input.requestItemId,
      input.requestItemPath,
      input.lastError,
      input.lastInboundMessageTs,
      input.pendingRequest ? JSON.stringify(input.pendingRequest) : null,
      createdAt,
      updatedAt,
    );
    return this.getWorker(input.teamId, input.channelId, input.rootTs)!;
  }

  updateWorkerState(
    key: string,
    patch: Partial<Pick<WorkerRecord, "activeTurnId" | "status" | "currentAgentSlackTs" | "currentAgentItemId" | "currentWorklogSlackTs" | "settings" | "lastError" | "lastInboundMessageTs" | "pendingRequest" | "workstreamId" | "requestItemId" | "requestItemPath">>,
  ): void {
    const worker = this.getWorkerByKey(key);
    if (!worker) return;
    this.db.prepare(`
      UPDATE workers SET
        workstream_id = ?,
        active_turn_id = ?,
        status = ?,
        current_agent_slack_ts = ?,
        current_agent_item_id = ?,
        current_worklog_slack_ts = ?,
        settings_json = ?,
        request_item_id = ?,
        request_item_path = ?,
        last_error = ?,
        last_inbound_message_ts = ?,
        pending_request_json = ?,
        updated_at = ?
      WHERE key = ?
    `).run(
      Object.hasOwn(patch, "workstreamId") ? patch.workstreamId : worker.workstreamId,
      Object.hasOwn(patch, "activeTurnId") ? patch.activeTurnId : worker.activeTurnId,
      Object.hasOwn(patch, "status") ? patch.status : worker.status,
      Object.hasOwn(patch, "currentAgentSlackTs") ? patch.currentAgentSlackTs : worker.currentAgentSlackTs,
      Object.hasOwn(patch, "currentAgentItemId") ? patch.currentAgentItemId : worker.currentAgentItemId,
      Object.hasOwn(patch, "currentWorklogSlackTs") ? patch.currentWorklogSlackTs : worker.currentWorklogSlackTs,
      JSON.stringify(Object.hasOwn(patch, "settings") ? patch.settings : worker.settings),
      Object.hasOwn(patch, "requestItemId") ? patch.requestItemId : worker.requestItemId,
      Object.hasOwn(patch, "requestItemPath") ? patch.requestItemPath : worker.requestItemPath,
      Object.hasOwn(patch, "lastError") ? patch.lastError : worker.lastError,
      Object.hasOwn(patch, "lastInboundMessageTs") ? patch.lastInboundMessageTs : worker.lastInboundMessageTs,
      Object.hasOwn(patch, "pendingRequest") ? JSON.stringify(patch.pendingRequest) : JSON.stringify(worker.pendingRequest),
      nowIso(),
      key,
    );
  }

  getDmSession(teamId: string, userId: string): DmSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM dm_sessions WHERE team_id = ? AND user_id = ?").get(teamId, userId) as Record<string, unknown> | undefined;
    return row ? this.toDmSession(row) : null;
  }

  listDmSessions(): DmSessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM dm_sessions ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.toDmSession(row));
  }

  listDmSessionsWithActiveTurns(): DmSessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM dm_sessions WHERE active_turn_id IS NOT NULL ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.toDmSession(row));
  }

  upsertDmSession(input: Omit<DmSessionRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): DmSessionRecord {
    const current = this.getDmSession(input.teamId, input.userId);
    const createdAt = current?.createdAt ?? input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO dm_sessions (
        team_id, user_id, channel_id, app_thread_id, active_turn_id, status, current_agent_slack_ts, current_agent_item_id,
        current_worklog_slack_ts, settings_json, last_error, last_inbound_message_ts, pending_request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, user_id) DO UPDATE SET
        channel_id=excluded.channel_id,
        app_thread_id=excluded.app_thread_id,
        active_turn_id=excluded.active_turn_id,
        status=excluded.status,
        current_agent_slack_ts=excluded.current_agent_slack_ts,
        current_agent_item_id=excluded.current_agent_item_id,
        current_worklog_slack_ts=excluded.current_worklog_slack_ts,
        settings_json=excluded.settings_json,
        last_error=excluded.last_error,
        last_inbound_message_ts=excluded.last_inbound_message_ts,
        pending_request_json=excluded.pending_request_json,
        updated_at=excluded.updated_at
    `).run(
      input.teamId,
      input.userId,
      input.channelId,
      input.appThreadId,
      input.activeTurnId,
      input.status,
      input.currentAgentSlackTs,
      input.currentAgentItemId,
      input.currentWorklogSlackTs,
      JSON.stringify(input.settings),
      input.lastError,
      input.lastInboundMessageTs,
      input.pendingRequest ? JSON.stringify(input.pendingRequest) : null,
      createdAt,
      updatedAt,
    );
    return this.getDmSession(input.teamId, input.userId)!;
  }

  getTeamDefaults(teamId: string): TeamDefaults {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(`defaults:${teamId}`) as { value?: string } | undefined;
    if (!row?.value) {
      return { ...DEFAULT_RUNTIME_SETTINGS };
    }
    try {
      const parsed = JSON.parse(row.value) as Partial<TeamDefaults>;
      return {
        model: typeof parsed.model === "string" ? parsed.model : DEFAULT_RUNTIME_SETTINGS.model,
        effort: typeof parsed.effort === "string" ? parsed.effort as TeamDefaults["effort"] : DEFAULT_RUNTIME_SETTINGS.effort,
      };
    } catch {
      return { ...DEFAULT_RUNTIME_SETTINGS };
    }
  }

  setTeamDefaults(teamId: string, defaults: TeamDefaults): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(`defaults:${teamId}`, JSON.stringify(defaults));
  }

  getPendingRestart(): PendingRestartRecord | null {
    return this.readJsonMetadata<PendingRestartRecord>("restart:pending");
  }

  setPendingRestart(record: PendingRestartRecord): void {
    this.writeJsonMetadata("restart:pending", record);
  }

  clearPendingRestart(): void {
    this.deleteMetadata("restart:pending");
  }

  consumePendingRestartNotice(): PendingRestartRecord | null {
    const notice = this.readJsonMetadata<PendingRestartRecord>("restart:notice");
    if (!notice) return null;
    this.deleteMetadata("restart:notice");
    return notice;
  }

  setPendingRestartNotice(record: PendingRestartRecord): void {
    this.writeJsonMetadata("restart:notice", record);
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
        WHERE team_id = ? AND is_member = 1 AND lower(name) LIKE ?
        ORDER BY name ASC
      `).all(teamId, like) as Record<string, unknown>[];
      return rows.map((row) => this.toChannel(row));
    }
    const rows = this.db.prepare("SELECT * FROM channel_cache WHERE team_id = ? AND is_member = 1 ORDER BY name ASC").all(teamId) as Record<string, unknown>[];
    return rows.map((row) => this.toChannel(row));
  }

  getWorkstreamById(id: string): WorkstreamRecord | null {
    const row = this.db.prepare("SELECT * FROM workstreams WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toWorkstream(row) : null;
  }

  getWorkstreamByChannel(teamId: string, channelId: string): WorkstreamRecord | null {
    const row = this.db.prepare("SELECT * FROM workstreams WHERE team_id = ? AND channel_id = ?").get(teamId, channelId) as Record<string, unknown> | undefined;
    return row ? this.toWorkstream(row) : null;
  }

  getWorkstreamByRelativePath(teamId: string, relativePath: string): WorkstreamRecord | null {
    const row = this.db.prepare("SELECT * FROM workstreams WHERE team_id = ? AND relative_path = ?").get(teamId, relativePath) as Record<string, unknown> | undefined;
    return row ? this.toWorkstream(row) : null;
  }

  listWorkstreams(teamId: string): WorkstreamRecord[] {
    const rows = this.db.prepare("SELECT * FROM workstreams WHERE team_id = ? ORDER BY relative_path ASC").all(teamId) as Record<string, unknown>[];
    return rows.map((row) => this.toWorkstream(row));
  }

  upsertWorkstream(input: Omit<WorkstreamRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): WorkstreamRecord {
    const current = this.getWorkstreamById(input.id);
    const createdAt = current?.createdAt ?? input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO workstreams (
        id, team_id, parent_id, slug, relative_path, channel_id, channel_name, description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_id=excluded.parent_id,
        slug=excluded.slug,
        relative_path=excluded.relative_path,
        channel_id=excluded.channel_id,
        channel_name=excluded.channel_name,
        description=excluded.description,
        updated_at=excluded.updated_at
    `).run(
      input.id,
      input.teamId,
      input.parentId,
      input.slug,
      input.relativePath,
      input.channelId,
      input.channelName,
      input.description,
      createdAt,
      updatedAt,
    );
    return this.getWorkstreamById(input.id)!;
  }

  getRegistration(id: string): RegistrationRecord | null {
    const row = this.db.prepare("SELECT * FROM registrations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toRegistration(row) : null;
  }

  listRegistrationsForTeam(teamId: string): RegistrationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM registrations
      WHERE team_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(teamId) as Record<string, unknown>[];
    return rows.map((row) => this.toRegistration(row));
  }

  listRegistrationsForWorkstream(workstreamId: string): RegistrationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM registrations
      WHERE workstream_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(workstreamId) as Record<string, unknown>[];
    return rows.map((row) => this.toRegistration(row));
  }

  listRegistrationsForScope(teamId: string, workstreamId: string, workerKey: string | null = null): RegistrationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM registrations
      WHERE team_id = ?
        AND (
          (workstream_id = ? AND worker_key IS NULL)
          OR worker_key = ?
        )
      ORDER BY created_at ASC, id ASC
    `).all(teamId, workstreamId, workerKey) as Record<string, unknown>[];
    return rows.map((row) => this.toRegistration(row));
  }

  upsertRegistration(
    input: Omit<RegistrationRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string },
  ): RegistrationRecord {
    const current = this.getRegistration(input.id);
    const createdAt = current?.createdAt ?? input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    const derivedTarget = {
      kind: input.target.workerKey ? "worker" as const : "workstream" as const,
      workstreamId: input.target.workstreamId,
      workerKey: input.target.workerKey ?? null,
    };
    this.db.prepare(`
      INSERT INTO registrations (
        id, team_id, workstream_id, worker_key, owner_user_id, root_owner_user_id, description, enabled, target_json, action_json, trigger_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workstream_id=excluded.workstream_id,
        worker_key=excluded.worker_key,
        owner_user_id=excluded.owner_user_id,
        root_owner_user_id=excluded.root_owner_user_id,
        description=excluded.description,
        enabled=excluded.enabled,
        target_json=excluded.target_json,
        action_json=excluded.action_json,
        trigger_json=excluded.trigger_json,
        updated_at=excluded.updated_at
    `).run(
      input.id,
      input.teamId,
      derivedTarget.workstreamId,
      derivedTarget.workerKey,
      input.ownerUserId,
      input.rootOwnerUserId,
      input.description,
      input.enabled ? 1 : 0,
      JSON.stringify(derivedTarget),
      JSON.stringify(input.action),
      JSON.stringify(input.trigger),
      createdAt,
      updatedAt,
    );
    return this.getRegistration(input.id)!;
  }

  disableRegistration(id: string): RegistrationRecord | null {
    const current = this.getRegistration(id);
    if (!current) return null;
    this.db.prepare(`
      UPDATE registrations
      SET enabled = 0, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), id);
    return this.getRegistration(id);
  }

  listPendingWakesForScope(teamId: string, workstreamId: string, workerKey: string | null = null): PendingWakeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM pending_wakes
      WHERE team_id = ?
        AND (
          (workstream_id = ? AND worker_key IS NULL)
          OR worker_key = ?
        )
      ORDER BY created_at ASC, id ASC
    `).all(teamId, workstreamId, workerKey) as Record<string, unknown>[];
    return rows.map((row) => this.toPendingWake(row));
  }

  getPendingWake(id: string): PendingWakeRecord | null {
    const row = this.db.prepare("SELECT * FROM pending_wakes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toPendingWake(row) : null;
  }

  getLatestPendingWakeForRegistration(registrationId: string): PendingWakeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM pending_wakes
      WHERE registration_id = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(registrationId) as Record<string, unknown> | undefined;
    return row ? this.toPendingWake(row) : null;
  }

  listQueuedPendingWakes(): PendingWakeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM pending_wakes
      WHERE status = 'queued'
      ORDER BY created_at ASC, id ASC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.toPendingWake(row));
  }

  createPendingWake(
    input: Omit<PendingWakeRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string },
  ): PendingWakeRecord {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db.prepare(`
      INSERT INTO pending_wakes (
        id, team_id, registration_id, workstream_id, worker_key, status, summary, payload_path, due_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.teamId,
      input.registrationId,
      input.workstreamId,
      input.workerKey,
      input.status,
      input.summary,
      input.payloadPath,
      input.dueAt,
      createdAt,
      updatedAt,
    );
    return this.getPendingWake(input.id)!;
  }

  updatePendingWake(id: string, patch: Partial<Pick<PendingWakeRecord, "status" | "summary" | "payloadPath" | "dueAt">>): PendingWakeRecord | null {
    const current = this.getPendingWake(id);
    if (!current) return null;
    this.db.prepare(`
      UPDATE pending_wakes SET
        status = ?,
        summary = ?,
        payload_path = ?,
        due_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      Object.hasOwn(patch, "status") ? patch.status : current.status,
      Object.hasOwn(patch, "summary") ? patch.summary : current.summary,
      Object.hasOwn(patch, "payloadPath") ? patch.payloadPath : current.payloadPath,
      Object.hasOwn(patch, "dueAt") ? patch.dueAt : current.dueAt,
      nowIso(),
      id,
    );
    return this.getPendingWake(id);
  }

  getPendingWorkerShell(id: string): PendingWorkerShellRecord | null {
    const row = this.db.prepare("SELECT * FROM pending_worker_shells WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toPendingWorkerShell(row) : null;
  }

  getPendingWorkerShellByRoot(teamId: string, channelId: string, rootTs: string): PendingWorkerShellRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM pending_worker_shells
      WHERE team_id = ? AND channel_id = ? AND root_ts = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(teamId, channelId, rootTs) as Record<string, unknown> | undefined;
    return row ? this.toPendingWorkerShell(row) : null;
  }

  upsertPendingWorkerShell(
    input: Omit<PendingWorkerShellRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string },
  ): PendingWorkerShellRecord {
    const current = this.getPendingWorkerShell(input.id);
    const createdAt = current?.createdAt ?? input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO pending_worker_shells (
        id, team_id, workstream_id, channel_id, root_ts, title, request_item_id, request_item_path,
        owner_user_id, root_owner_user_id, settings_json, identity_json, parent_worker_key,
        source_json, status, app_thread_id, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel_id=excluded.channel_id,
        root_ts=excluded.root_ts,
        title=excluded.title,
        request_item_id=excluded.request_item_id,
        request_item_path=excluded.request_item_path,
        owner_user_id=excluded.owner_user_id,
        root_owner_user_id=excluded.root_owner_user_id,
        settings_json=excluded.settings_json,
        identity_json=excluded.identity_json,
        parent_worker_key=excluded.parent_worker_key,
        source_json=excluded.source_json,
        status=excluded.status,
        app_thread_id=excluded.app_thread_id,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at
    `).run(
      input.id,
      input.teamId,
      input.workstreamId,
      input.channelId,
      input.rootTs,
      input.title,
      input.requestItemId,
      input.requestItemPath,
      input.ownerUserId,
      input.rootOwnerUserId,
      JSON.stringify(input.settings),
      input.identity ? JSON.stringify(input.identity) : null,
      input.parentWorkerKey,
      JSON.stringify(input.source),
      input.status,
      input.appThreadId,
      input.lastError,
      createdAt,
      updatedAt,
    );
    return this.getPendingWorkerShell(input.id)!;
  }

  deletePendingWorkerShell(id: string): void {
    this.db.prepare("DELETE FROM pending_worker_shells WHERE id = ?").run(id);
  }

  createOrGetInboundMessage(input: {
    key: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    rootTs: string;
    kind: InboundMessageKind;
    payloadJson: string;
  }): InboundMessageRecord {
    this.db.prepare(`
      INSERT INTO inbound_messages (
        key, team_id, channel_id, message_ts, root_ts, kind, payload_json, status, attempts, retryable, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', 0, 1, ?, ?)
      ON CONFLICT(team_id, channel_id, message_ts, kind) DO UPDATE SET
        payload_json=excluded.payload_json,
        root_ts=excluded.root_ts,
        updated_at=excluded.updated_at
    `).run(
      input.key,
      input.teamId,
      input.channelId,
      input.messageTs,
      input.rootTs,
      input.kind,
      input.payloadJson,
      nowIso(),
      nowIso(),
    );
    return this.getInboundMessage(input.key)!;
  }

  getInboundMessage(key: string): InboundMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM inbound_messages WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    return row ? this.toInboundMessage(row) : null;
  }

  listReplayableInboundMessages(): InboundMessageRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM inbound_messages
      WHERE status = 'received'
        OR (status = 'failed' AND retryable = 1 AND attempts < 3)
      ORDER BY created_at ASC, key ASC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.toInboundMessage(row));
  }

  resetInterruptedInboundMessages(): void {
    this.db.prepare(`
      UPDATE inbound_messages
      SET status = 'received', updated_at = ?
      WHERE status = 'processing'
    `).run(nowIso());
  }

  claimInboundMessage(key: string): InboundMessageRecord | null {
    const updated = this.db.prepare(`
      UPDATE inbound_messages
      SET status = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE key = ? AND (status = 'received' OR (status = 'failed' AND retryable = 1))
    `).run(nowIso(), key);
    if (updated.changes < 1) {
      return null;
    }
    return this.getInboundMessage(key);
  }

  updateInboundMessageProgress(
    key: string,
    patch: Partial<Pick<InboundMessageRecord, "workerKey" | "appThreadId" | "turnId" | "lastError">>,
  ): void {
    const current = this.getInboundMessage(key);
    if (!current) return;
    this.db.prepare(`
      UPDATE inbound_messages
      SET worker_key = ?, app_thread_id = ?, turn_id = ?, last_error = ?, updated_at = ?
      WHERE key = ?
    `).run(
      Object.hasOwn(patch, "workerKey") ? patch.workerKey : current.workerKey,
      Object.hasOwn(patch, "appThreadId") ? patch.appThreadId : current.appThreadId,
      Object.hasOwn(patch, "turnId") ? patch.turnId : current.turnId,
      Object.hasOwn(patch, "lastError") ? patch.lastError : current.lastError,
      nowIso(),
      key,
    );
  }

  markInboundMessageProcessed(key: string, patch?: Partial<Pick<InboundMessageRecord, "workerKey" | "appThreadId" | "turnId">>): void {
    const current = this.getInboundMessage(key);
    if (!current) return;
    this.db.prepare(`
      UPDATE inbound_messages
      SET status = 'processed', retryable = 0, worker_key = ?, app_thread_id = ?, turn_id = ?, last_error = NULL, updated_at = ?
      WHERE key = ?
    `).run(
      Object.hasOwn(patch ?? {}, "workerKey") ? patch?.workerKey : current.workerKey,
      Object.hasOwn(patch ?? {}, "appThreadId") ? patch?.appThreadId : current.appThreadId,
      Object.hasOwn(patch ?? {}, "turnId") ? patch?.turnId : current.turnId,
      nowIso(),
      key,
    );
  }

  markInboundMessageFailed(key: string, errorText: string): void {
    this.db.prepare(`
      UPDATE inbound_messages
      SET status = 'failed', retryable = 1, last_error = ?, updated_at = ?
      WHERE key = ?
    `).run(errorText, nowIso(), key);
  }

  markInboundMessageRejected(key: string, errorText: string): void {
    this.db.prepare(`
      UPDATE inbound_messages
      SET status = 'failed', retryable = 0, last_error = ?, updated_at = ?
      WHERE key = ?
    `).run(errorText, nowIso(), key);
  }

  listAttachmentsForMessage(messageKey: string): MessageAttachmentRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM message_attachments
      WHERE message_key = ?
      ORDER BY created_at ASC
    `).all(messageKey) as Record<string, unknown>[];
    return rows.map((row) => this.toAttachment(row));
  }

  upsertAttachments(records: MessageAttachmentRecord[]): void {
    if (records.length === 0) return;
    const statement = this.db.prepare(`
      INSERT INTO message_attachments (
        key, message_key, slack_file_id, name, mimetype, local_path, is_image, size_bytes, status, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_key, slack_file_id) DO UPDATE SET
        local_path=excluded.local_path,
        is_image=excluded.is_image,
        size_bytes=excluded.size_bytes,
        status=excluded.status,
        note=excluded.note,
        updated_at=excluded.updated_at
    `);
    const transaction = this.db.transaction((items: MessageAttachmentRecord[]) => {
      for (const record of items) {
        statement.run(
          record.key,
          record.messageKey,
          record.slackFileId,
          record.name,
          record.mimetype,
          record.localPath,
          record.isImage ? 1 : 0,
          record.sizeBytes,
          record.status,
          record.note,
          record.createdAt,
          record.updatedAt,
        );
      }
    });
    transaction(records);
  }

  private toWorker(row: Record<string, unknown>): WorkerRecord {
    return {
      key: String(row.key),
      teamId: String(row.team_id),
      channelId: String(row.channel_id),
      rootTs: String(row.root_ts),
      workstreamId: row.workstream_id ? String(row.workstream_id) : null,
      appThreadId: String(row.app_thread_id),
      activeTurnId: row.active_turn_id ? String(row.active_turn_id) : null,
      ownerUserId: String(row.owner_user_id),
      rootOwnerUserId: String(row.root_owner_user_id),
      status: String(row.status) as SessionStatus,
      currentAgentSlackTs: row.current_agent_slack_ts ? String(row.current_agent_slack_ts) : null,
      currentAgentItemId: row.current_agent_item_id ? String(row.current_agent_item_id) : null,
      currentWorklogSlackTs: row.current_worklog_slack_ts ? String(row.current_worklog_slack_ts) : null,
      settings: parseSettings(typeof row.settings_json === "string" ? row.settings_json : null),
      identity: parseIdentity(typeof row.identity_json === "string" ? row.identity_json : null),
      parentWorkerKey: row.parent_worker_key ? String(row.parent_worker_key) : null,
      requestItemId: row.request_item_id ? String(row.request_item_id) : null,
      requestItemPath: row.request_item_path ? String(row.request_item_path) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      lastInboundMessageTs: row.last_inbound_message_ts ? String(row.last_inbound_message_ts) : null,
      pendingRequest: parsePendingRequest(typeof row.pending_request_json === "string" ? row.pending_request_json : null),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toWorkstream(row: Record<string, unknown>): WorkstreamRecord {
    return {
      id: String(row.id),
      teamId: String(row.team_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      slug: String(row.slug),
      relativePath: String(row.relative_path),
      channelId: String(row.channel_id),
      channelName: String(row.channel_name),
      description: row.description ? String(row.description) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toRegistration(row: Record<string, unknown>): RegistrationRecord {
    const workstreamId = String(row.workstream_id);
    const workerKey = row.worker_key ? String(row.worker_key) : null;
    return {
      id: String(row.id),
      teamId: String(row.team_id),
      workstreamId,
      workerKey,
      ownerUserId: String(row.owner_user_id ?? ""),
      rootOwnerUserId: String(row.root_owner_user_id ?? ""),
      description: row.description ? String(row.description) : null,
      enabled: Boolean(row.enabled),
      target: {
        kind: workerKey ? "worker" : "workstream",
        workstreamId,
        workerKey,
      },
      action: parseRegistrationAction(typeof row.action_json === "string" ? row.action_json : null),
      trigger: parseRegistrationTrigger(typeof row.trigger_json === "string" ? row.trigger_json : null),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toPendingWake(row: Record<string, unknown>): PendingWakeRecord {
    return {
      id: String(row.id),
      teamId: String(row.team_id),
      registrationId: String(row.registration_id),
      workstreamId: String(row.workstream_id),
      workerKey: row.worker_key ? String(row.worker_key) : null,
      status: String(row.status) as PendingWakeRecord["status"],
      summary: String(row.summary),
      payloadPath: row.payload_path ? String(row.payload_path) : null,
      dueAt: row.due_at ? String(row.due_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toPendingWorkerShell(row: Record<string, unknown>): PendingWorkerShellRecord {
    return {
      id: String(row.id),
      teamId: String(row.team_id),
      workstreamId: String(row.workstream_id),
      channelId: String(row.channel_id),
      rootTs: row.root_ts ? String(row.root_ts) : null,
      title: String(row.title),
      requestItemId: row.request_item_id ? String(row.request_item_id) : null,
      requestItemPath: row.request_item_path ? String(row.request_item_path) : null,
      ownerUserId: String(row.owner_user_id),
      rootOwnerUserId: String(row.root_owner_user_id),
      settings: parseSettings(typeof row.settings_json === "string" ? row.settings_json : null),
      identity: parseIdentity(typeof row.identity_json === "string" ? row.identity_json : null),
      parentWorkerKey: row.parent_worker_key ? String(row.parent_worker_key) : null,
      source: parsePendingWorkerShellSource(typeof row.source_json === "string" ? row.source_json : null),
      status: String(row.status) as PendingWorkerShellRecord["status"],
      appThreadId: row.app_thread_id ? String(row.app_thread_id) : null,
      lastError: row.last_error ? String(row.last_error) : null,
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
      status: String(row.status ?? "idle") as SessionStatus,
      currentAgentSlackTs: row.current_agent_slack_ts ? String(row.current_agent_slack_ts) : null,
      currentAgentItemId: row.current_agent_item_id ? String(row.current_agent_item_id) : null,
      currentWorklogSlackTs: row.current_worklog_slack_ts ? String(row.current_worklog_slack_ts) : null,
      settings: parseSettings(typeof row.settings_json === "string" ? row.settings_json : null),
      lastError: row.last_error ? String(row.last_error) : null,
      lastInboundMessageTs: row.last_inbound_message_ts ? String(row.last_inbound_message_ts) : null,
      pendingRequest: parsePendingRequest(typeof row.pending_request_json === "string" ? row.pending_request_json : null),
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

  private toInboundMessage(row: Record<string, unknown>): InboundMessageRecord {
    return {
      key: String(row.key),
      teamId: String(row.team_id),
      channelId: String(row.channel_id),
      messageTs: String(row.message_ts),
      rootTs: String(row.root_ts),
      kind: String(row.kind) as InboundMessageKind,
      payloadJson: String(row.payload_json),
      status: String(row.status) as InboundMessageStatus,
      attempts: Number(row.attempts ?? 0),
      retryable: Boolean(row.retryable),
      lastError: row.last_error ? String(row.last_error) : null,
      workerKey: row.worker_key ? String(row.worker_key) : null,
      appThreadId: row.app_thread_id ? String(row.app_thread_id) : null,
      turnId: row.turn_id ? String(row.turn_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toAttachment(row: Record<string, unknown>): MessageAttachmentRecord {
    return {
      key: String(row.key),
      messageKey: String(row.message_key),
      slackFileId: String(row.slack_file_id),
      name: String(row.name),
      mimetype: String(row.mimetype),
      localPath: String(row.local_path),
      isImage: Boolean(row.is_image),
      sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
      status: String(row.status) as MessageAttachmentRecord["status"],
      note: row.note ? String(row.note) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private readJsonMetadata<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private writeJsonMetadata(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, JSON.stringify(value));
  }

  private deleteMetadata(key: string): void {
    this.db.prepare("DELETE FROM metadata WHERE key = ?").run(key);
  }
}
