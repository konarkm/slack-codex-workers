export interface TeamAppManifestInput {
  // The app's name in Slack, e.g. "Agents". People never have to type it; agents are addressed by their own names.
  appName: string;
  // Declares the app as a Slack agent: working indicator and stop button per thread.
  agentView: boolean;
}

const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  // Lets each agent post under its own name and icon.
  "chat:write.customize",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  // Lets agents search the workspace (assistant.search.context) with the bot token.
  "search:read.files",
  "search:read.public",
  "search:read.users",
  "users:read",
];

const BOT_EVENTS = ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim", "member_joined_channel", "reaction_added"];

// One Slack app for the whole team of agents. Slack gives an app a single bot user, so the agents are personas of it:
// each posts under its own name and icon, and the bridge works out who a message is for.
export function buildTeamAppManifest(input: TeamAppManifestInput): Record<string, unknown> {
  const description = "A team of AI agents. Talk to them by name, the way you would a colleague.";
  return {
    display_information: { name: input.appName, description },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: input.appName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), always_online: true },
      ...(input.agentView ? { agent_view: { agent_description: description } } : {}),
    },
    oauth_config: { scopes: { bot: input.agentView ? [...BOT_SCOPES, "assistant:write"] : BOT_SCOPES } },
    settings: {
      // app_context_changed also makes Slack attach what the person is viewing to their DMs.
      event_subscriptions: { bot_events: input.agentView ? [...BOT_EVENTS, "agent_session_stopped", "agent_session_title_changed", "app_context_changed", "app_home_opened"] : BOT_EVENTS },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
