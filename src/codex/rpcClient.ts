import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import type { JsonRpcId, JsonRpcIncoming, JsonRpcRequest, JsonRpcResponse } from "../types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcNotification {
  method: string;
  params: unknown;
}

export interface RpcServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export class CodexRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private requestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private childExitPromise: Promise<void> | null = null;
  private childExitResolve: (() => void) | null = null;

  constructor(
    private readonly codexBin: string,
    private readonly cwd: string,
    private readonly clientInfo: { name: string; title: string; version: string },
    // Overrides the local spawn, e.g. to run the app-server on another machine over ssh.
    private readonly spawnChild?: () => ChildProcessWithoutNullStreams,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;

    const child = this.spawnChild
      ? this.spawnChild()
      : spawn(this.codexBin, ["app-server"], {
        cwd: this.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    this.child = child;
    this.childExitPromise = new Promise<void>((resolve) => {
      this.childExitResolve = resolve;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));

    // A pipe that breaks before the exit is seen (the app-server or its ssh transport died) fails the requests waiting on
    // it and ends the process; unhandled, the error would take the whole hub down.
    child.stdin.on("error", (error) => {
      if (this.child !== child) return;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit("stderr", `stdin: ${error.message}`);
      child.kill("SIGTERM");
    });

    child.on("error", (error) => {
      if (this.child === child) {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.child = null;
      }
      this.childExitResolve?.();
      this.childExitResolve = null;
      this.childExitPromise = null;
      this.emit("stderr", error.message);
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) {
        const error = new Error(`codex app-server exited code=${String(code)} signal=${String(signal)}`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.child = null;
      }
      this.childExitResolve?.();
      this.childExitResolve = null;
      this.childExitPromise = null;
      this.emit("exit", { code, signal });
    });

    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    await this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    await this.childExitPromise;
  }

  async request<T>(method: string, params: unknown, timeoutMs = 180_000): Promise<T> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("codex app-server is not running");
    const id = this.requestId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    child.stdin.write(`${JSON.stringify(req)}\n`);
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("codex app-server is not running");
    const req: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    child.stdin.write(`${JSON.stringify(req)}\n`);
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("codex app-server is not running");
    const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  async respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("codex app-server is not running");
    const response: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
    child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  isRunning(): boolean {
    return Boolean(this.child?.stdin.writable);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: JsonRpcIncoming;
      try {
        parsed = JSON.parse(line) as JsonRpcIncoming;
      } catch {
        continue;
      }

      const hasId = Object.prototype.hasOwnProperty.call(parsed, "id");
      const id = hasId ? (parsed as JsonRpcResponse).id : undefined;

      if (hasId && id !== undefined && id !== null && Object.prototype.hasOwnProperty.call(parsed, "result")) {
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve((parsed as JsonRpcResponse).result);
        continue;
      }

      if (hasId && id !== undefined && id !== null && Object.prototype.hasOwnProperty.call(parsed, "error")) {
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error((parsed as JsonRpcResponse).error?.message ?? "Unknown RPC error"));
        continue;
      }

      if (hasId && id !== undefined && id !== null && "method" in parsed) {
        this.emit("request", {
          id,
          method: String((parsed as JsonRpcRequest).method),
          params: (parsed as JsonRpcRequest).params,
        } satisfies RpcServerRequest);
        continue;
      }

      if (!hasId && "method" in parsed) {
        this.emit("notification", {
          method: String((parsed as JsonRpcRequest).method),
          params: (parsed as JsonRpcRequest).params,
        } satisfies RpcNotification);
      }
    }
  }
}
