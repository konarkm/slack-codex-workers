// Creates the one Slack app the whole team of agents speaks through. Done once per workspace; adding agents needs no Slack setup.
// Usage: tsx scripts/provision-app.ts [--name "Agents"] [--no-agent-view] [--dry-run]
// Needs an app configuration token for the target workspace (api.slack.com/apps → "Your App Configuration Tokens"):
//   SLACK_CONFIG_TOKEN, and optionally SLACK_CONFIG_REFRESH_TOKEN so the 12-hour token can be rotated.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { WebClient } from "@slack/web-api";
import { config as loadDotEnv } from "dotenv";
import { buildTeamAppManifest } from "../src/provision/manifest.js";

loadDotEnv({ quiet: true });

const args = process.argv.slice(2);
const nameIndex = args.indexOf("--name");
const appName = nameIndex >= 0 ? (args[nameIndex + 1] ?? "Agents") : "Agents";
const manifest = buildTeamAppManifest({ appName, agentView: !args.includes("--no-agent-view") });

if (args.includes("--dry-run")) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

const stateRoot = path.resolve(process.env.AGENTS_STATE_ROOT ?? path.join(os.homedir(), ".slack-agents"));
const tokenFile = path.join(stateRoot, "slack-config-token.json");
const saved = fs.existsSync(tokenFile) ? (JSON.parse(fs.readFileSync(tokenFile, "utf8")) as { token?: string; refreshToken?: string }) : {};
let token = saved.token ?? process.env.SLACK_CONFIG_TOKEN;
const refreshToken = saved.refreshToken ?? process.env.SLACK_CONFIG_REFRESH_TOKEN;

const web = new WebClient();
if (refreshToken) {
  // Each rotation invalidates the old pair, so the new pair is saved before anything else happens.
  const rotated = (await web.apiCall("tooling.tokens.rotate", { refresh_token: refreshToken })) as { token?: string; refresh_token?: string };
  if (!rotated.token || !rotated.refresh_token) throw new Error("tooling.tokens.rotate returned no token");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({ token: rotated.token, refreshToken: rotated.refresh_token }, null, 2), { mode: 0o600 });
  token = rotated.token;
}
if (!token) throw new Error("Set SLACK_CONFIG_TOKEN (and SLACK_CONFIG_REFRESH_TOKEN) first.");

const created = (await web.apiCall("apps.manifest.create", { token, manifest: JSON.stringify(manifest) })) as {
  app_id?: string;
  oauth_authorize_url?: string;
};
if (!created.app_id) throw new Error(`apps.manifest.create returned no app id: ${JSON.stringify(created)}`);

console.log(
  [
    `Created Slack app ${created.app_id} ("${appName}").`,
    "",
    "Two steps need a person, once, about a minute in total:",
    `1. Install it to the workspace: ${created.oauth_authorize_url}`,
    `   Then copy the Bot User OAuth Token from https://api.slack.com/apps/${created.app_id}/oauth into SLACK_BOT_TOKEN.`,
    `2. Generate an app-level token with the connections:write scope at https://api.slack.com/apps/${created.app_id}/general`,
    "   and put it in SLACK_APP_TOKEN.",
    "",
    "Invite the app to the channels the agents should hear. Agents themselves are entries in agents.json, or made by other agents.",
  ].join("\n"),
);
