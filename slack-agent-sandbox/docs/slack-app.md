# Slack app

Atlas connects over Socket Mode, so it needs no public URL. Use a **separate dev app** when running locally, so a local process never competes with a deployed one for the same events.

## Create the app

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick the workspace, and paste the manifest below.
2. **Basic Information** → **App-Level Tokens** → generate one with `connections:write`. That's `SLACK_APP_TOKEN` (`xapp-...`).
3. **Install App** → install to the workspace. The **Bot User OAuth Token** is `SLACK_BOT_TOKEN` (`xoxb-...`).
4. Put both in `.env.local`, and your Slack user ID or email in `SLACK_ALLOWLIST`.

```yaml
display_information:
  name: Atlas (dev)
  description: Local development instance of Atlas
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: atlas-dev
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read  # app_mention events
      - chat:write         # the placeholder, progress edits, the answer, and deleting its own messages on cleanup
      - im:history         # message.im events, and thread history in DMs
      - channels:history   # thread history for a mention in a public channel
      - groups:history     # ...and in a private channel the app was added to
      - users:read         # email allowlist entries (access.ts)
      - users:read.email
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

For a deployed app, change the name and display name.

The bot subscribes to `message.im` and `app_mention` only, so the only events it receives are DMs and messages that mention it (`gateway.ts` ignores anything else that arrives anyway). In a channel, invite it first (`/invite @atlas-dev`).

## Run it locally

```sh
npm run start:slack
```

On start it cleans up any session or sandbox a previous process left in `STATE_DIR`, then connects. Ctrl-C stops taking messages, aborts runs in progress, revokes their sessions, deletes their sandboxes and replies in their threads before exiting; press it again to quit at once (the next start cleans up whatever that leaves).

Each message runs one paid Claude Code inference in a fresh sandbox.
