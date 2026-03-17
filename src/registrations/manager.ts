import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { Store } from "../db/store.js";
import { validateCronSchedule } from "./cron.js";
import type {
  PendingWakeRecord,
  RegistrationRecord,
  WebhookRegistrationTrigger,
  WorkstreamRecord,
  WorkerRecord,
} from "../types.js";
import { WorkstreamManager, formatWorkstreamAddress } from "../workstreams/manager.js";

export interface RegistrationContext {
  teamId: string;
  workstream: WorkstreamRecord;
  worker: WorkerRecord | null;
}

export class RegistrationManager {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly workstreams: WorkstreamManager,
  ) {}

  async setHeartbeat(
    ctx: RegistrationContext,
    input: { registrationId?: string | null; intervalMinutes: number; description?: string | null },
  ): Promise<RegistrationRecord> {
    if (!ctx.worker) {
      throw new Error("Heartbeat registrations require a worker thread context.");
    }
    this.ensureUpsertAllowed(ctx, input.registrationId);
    const record = this.store.upsertRegistration({
      id: this.resolveRegistrationId(input.registrationId),
      teamId: ctx.teamId,
      workstreamId: ctx.workstream.id,
      workerKey: ctx.worker.key,
      ownerUserId: ctx.worker.ownerUserId,
      rootOwnerUserId: ctx.worker.rootOwnerUserId,
      description: input.description ?? null,
      enabled: true,
      target: {
        kind: "worker",
        workstreamId: ctx.workstream.id,
        workerKey: ctx.worker.key,
      },
      action: { kind: "wake_self" },
      trigger: {
        kind: "heartbeat",
        intervalMinutes: input.intervalMinutes,
      },
    });
    await this.refreshProjection(record.workstreamId);
    return record;
  }

  async setCron(
    ctx: RegistrationContext,
    input: { registrationId?: string | null; schedule: string; target: "self" | "workstream"; description?: string | null },
  ): Promise<RegistrationRecord> {
    this.ensureUpsertAllowed(ctx, input.registrationId);
    validateCronSchedule(input.schedule);
    const target = this.resolveTarget(ctx, input.target);
    const action = input.target === "self" ? { kind: "wake_self" as const } : { kind: "spawn" as const };
    const record = this.store.upsertRegistration({
      id: this.resolveRegistrationId(input.registrationId),
      teamId: ctx.teamId,
      workstreamId: ctx.workstream.id,
      workerKey: target.workerKey,
      ownerUserId: ctx.worker?.ownerUserId ?? "",
      rootOwnerUserId: ctx.worker?.rootOwnerUserId ?? "",
      description: input.description ?? null,
      enabled: true,
      target,
      action,
      trigger: {
        kind: "cron",
        schedule: input.schedule,
        timezone: this.config.workspaceTimezone,
      },
    });
    await this.refreshProjection(record.workstreamId);
    return record;
  }

  async setWebhook(
    ctx: RegistrationContext,
    input: {
      registrationId?: string | null;
      source: string;
      events: string[];
      target: "self" | "workstream";
      description?: string | null;
      match?: Record<string, string> | null;
    },
  ): Promise<RegistrationRecord> {
    this.ensureUpsertAllowed(ctx, input.registrationId);
    const target = this.resolveTarget(ctx, input.target);
    const action = input.target === "self" ? { kind: "wake_self" as const } : { kind: "spawn" as const };
    const trigger: WebhookRegistrationTrigger = {
      kind: "webhook",
      source: input.source,
      events: input.events,
      match: input.match ?? null,
    };
    const record = this.store.upsertRegistration({
      id: this.resolveRegistrationId(input.registrationId),
      teamId: ctx.teamId,
      workstreamId: ctx.workstream.id,
      workerKey: target.workerKey,
      ownerUserId: ctx.worker?.ownerUserId ?? "",
      rootOwnerUserId: ctx.worker?.rootOwnerUserId ?? "",
      description: input.description ?? null,
      enabled: true,
      target,
      action,
      trigger,
    });
    await this.refreshProjection(record.workstreamId);
    return record;
  }

  async disableRegistration(ctx: RegistrationContext, registrationId: string): Promise<RegistrationRecord> {
    const current = this.requireAccessibleRegistration(ctx, registrationId);
    return (await this.disableRegistrationById(current.id)) ?? current;
  }

  async disableRegistrationById(registrationId: string): Promise<RegistrationRecord | null> {
    const updated = this.store.disableRegistration(registrationId);
    if (!updated) return null;
    await this.refreshProjection(updated.workstreamId);
    return updated;
  }

  getRegistration(ctx: RegistrationContext, registrationId: string): RegistrationRecord {
    return this.requireAccessibleRegistration(ctx, registrationId);
  }

  listRegistrations(ctx: RegistrationContext): RegistrationRecord[] {
    return this.store.listRegistrationsForScope(ctx.teamId, ctx.workstream.id, ctx.worker?.key ?? null);
  }

  listWakeDeliveries(ctx: RegistrationContext): PendingWakeRecord[] {
    return this.store.listPendingWakesForScope(ctx.teamId, ctx.workstream.id, ctx.worker?.key ?? null);
  }

  private requireAccessibleRegistration(ctx: RegistrationContext, registrationId: string): RegistrationRecord {
    const record = this.store.getRegistration(registrationId);
    if (!record || record.teamId !== ctx.teamId) {
      throw new Error("Registration not found.");
    }
    const isWorkstreamScoped = record.workstreamId === ctx.workstream.id && record.workerKey === null;
    const isWorkerScoped = Boolean(ctx.worker && record.workerKey === ctx.worker.key);
    if (!isWorkstreamScoped && !isWorkerScoped) {
      throw new Error("Registration is outside the current worker/workstream scope.");
    }
    return record;
  }

  private resolveRegistrationId(registrationId?: string | null): string {
    return registrationId?.trim() || `reg-${randomUUID().slice(0, 8)}`;
  }

  private ensureUpsertAllowed(ctx: RegistrationContext, registrationId?: string | null): void {
    const trimmed = registrationId?.trim();
    if (!trimmed) return;
    const existing = this.store.getRegistration(trimmed);
    if (!existing) return;
    this.requireAccessibleRegistration(ctx, trimmed);
  }

  private resolveTarget(
    ctx: RegistrationContext,
    target: "self" | "workstream",
  ): { kind: "worker" | "workstream"; workstreamId: string; workerKey: string | null } {
    if (target === "workstream") {
      return {
        kind: "workstream",
        workstreamId: ctx.workstream.id,
        workerKey: null,
      };
    }
    if (!ctx.worker) {
      throw new Error("Worker-targeted registrations require a worker thread context.");
    }
    return {
      kind: "worker",
      workstreamId: ctx.workstream.id,
      workerKey: ctx.worker.key,
    };
  }

  private async refreshProjection(workstreamId: string): Promise<void> {
    const workstream = this.store.getWorkstreamById(workstreamId);
    if (!workstream) return;
    const registrations = this.store.listRegistrationsForWorkstream(workstreamId);
    const projection = registrations.map((record) => this.toProjectionEntry(record));
    await this.workstreams.writeRegistrationsProjection(workstream, projection);
  }

  private toProjectionEntry(record: RegistrationRecord): Record<string, unknown> {
    const targetWorkstream = this.store.getWorkstreamById(record.target.workstreamId);
    return {
      id: record.id,
      enabled: record.enabled,
      description: record.description,
      target: {
        kind: record.target.kind,
        workstream: targetWorkstream ? formatWorkstreamAddress(targetWorkstream) : record.target.workstreamId,
        workerKey: record.target.workerKey,
      },
      action: record.action.kind,
      trigger: record.trigger,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
