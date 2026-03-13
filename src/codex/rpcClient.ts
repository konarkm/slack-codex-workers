import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

  constructor(
    private readonly codexBin: string,
    private readonly cwd: string,
    private readonly clientInfo: { name: string; title: string; version: string },
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;

    this.child = spawn(this.codexBin, ["app-server"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));

    this.child.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited code=${String(code)} signal=${String(signal)}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.emit("exit", { code, signal });
    });

    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    await this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
  }

  async request<T>(method: string, params: unknown, timeoutMs = 180_000): Promise<T> {
    if (!this.child?.stdin.writable) throw new Error("codex app-server is not running");
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

    this.child.stdin.write(`${JSON.stringify(req)}\n`);
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.child?.stdin.writable) throw new Error("codex app-server is not running");
    const req: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    if (!this.child?.stdin.writable) throw new Error("codex app-server is not running");
    const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  async respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    if (!this.child?.stdin.writable) throw new Error("codex app-server is not running");
    const response: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
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
