// Lists the models the local Codex login can use.
import { CodexRpcClient } from "../../src/codex/rpcClient.js";
const rpc = new CodexRpcClient(process.env.CODEX_BIN ?? "codex", process.cwd(), { name: "slack-agents", title: "Slack Agents", version: "0.2.0" });
await rpc.start();
const account = await rpc.request<{ account?: { type?: string; planType?: string } }>("account/read", {}).catch((error) => ({ error: String(error) }));
console.log("account:", JSON.stringify(account).replace(/"email":"[^"]*"/, '"email":"<redacted>"').slice(0, 200));
const models = await rpc.request<{ data: Array<{ id: string; displayName?: string; isDefault?: boolean }> }>("model/list", {});
for (const model of models.data) console.log(model.isDefault ? "*" : " ", model.id, "·", model.displayName ?? "");
await rpc.stop();
process.exit(0);
