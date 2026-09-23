import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolServer } from "../agents/toolServer.js";

let server: ToolServer;
let url: string;

async function rpc(token: string | null, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

beforeEach(async () => {
  server = new ToolServer({ bindHost: "127.0.0.1", port: 0, publicUrl: null });
  await server.start();
  // Port 0 resolves at listen time; read it back through the grant's url.
  url = server.grant("probe", []).url;
});

afterEach(async () => {
  await server.stop();
});

describe("ToolServer", () => {
  it("serves each agent its own tools behind its own token, and nothing without one", async () => {
    const calls: string[] = [];
    const ada = server.grant("ada", [{ name: "send", description: "send a message", shape: { text: z.string() }, handler: async (args) => { calls.push(`ada:${args.text}`); return "sent"; } }]);
    const cody = server.grant("cody", [{ name: "build", description: "build it", shape: {}, handler: async () => "built" }]);

    expect((await rpc(null, initialize)).status).toBe(401);
    expect((await rpc("nope", initialize)).status).toBe(401);

    const adaList = await rpc(ada.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(adaList.status).toBe(200);
    expect(adaList.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["send"]);
    expect(adaList.json.result.tools[0].inputSchema.properties.text.type).toBe("string");

    const codyList = await rpc(cody.token, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(codyList.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["build"]);

    const call = await rpc(ada.token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send", arguments: { text: "hi" } } });
    expect(call.json.result.content).toEqual([{ type: "text", text: "sent" }]);
    expect(calls).toEqual(["ada:hi"]);

    // A bad argument is an error result the agent can read, not a transport failure.
    const bad = await rpc(ada.token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "send", arguments: { text: 5 } } });
    expect(bad.status).toBe(200);
    expect(bad.json.error ?? bad.json.result?.isError).toBeTruthy();
  });

  it("replaces an agent's grant and revokes it", async () => {
    const first = server.grant("ada", [{ name: "one", description: "one", shape: {}, handler: async () => "1" }]);
    const second = server.grant("ada", [{ name: "one", description: "one", shape: {}, handler: async () => "1" }, { name: "two", description: "two", shape: {}, handler: async () => "2" }]);
    expect((await rpc(first.token, initialize)).status).toBe(401);
    const list = await rpc(second.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["one", "two"]);
    server.revoke("ada");
    expect((await rpc(second.token, initialize)).status).toBe(401);
  });

  it("uses the public url for agents on other machines", async () => {
    const remote = new ToolServer({ bindHost: "127.0.0.1", port: 0, publicUrl: "http://mini.tailnet:3015/mcp" });
    expect(remote.grant("scout", []).url).toBe("http://mini.tailnet:3015/mcp");
  });
});
