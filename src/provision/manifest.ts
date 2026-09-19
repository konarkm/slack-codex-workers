export interface AgentManifestInput {
  name: string;
  title: string | null;
  // Declares the app as a Slack agent: working indicator, stop button, agents sidebar.
  agentView: boolean;
}

const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
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
  "users:read",
];

const BOT_EVENTS = ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim", "member_joined_channel"];

function displayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// One Slack app per named agent: Slack gives each app exactly one bot user, and only a bot user can be @-mentioned or DMed.
export function buildAgentManifest(input: AgentManifestInput): Record<string, unknown> {
  const description = input.title ? `${displayName(input.name)}, ${input.title}` : `${displayName(input.name)}, an agent teammate`;
  return {
    display_information: { name: displayName(input.name), description: description.slice(0, 140) },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: input.name, always_online: true },
      ...(input.agentView ? { agent_view: { agent_description: description.slice(0, 140) } } : {}),
    },
    oauth_config: { scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: input.agentView ? [...BOT_EVENTS, "agent_session_stopped"] : BOT_EVENTS },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
