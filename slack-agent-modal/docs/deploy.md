# Deploying Apollo in Docker

Apollo ships as one container that runs the Slack Socket Mode orchestrator (`node dist/src/main.js`). It only makes outbound connections, to Slack, Modal and Infisical, so it publishes no ports and needs no public URL. The image holds the compiled JavaScript, production dependencies and [instructions/AGENTS.md](../instructions/AGENTS.md). Claude Code, the Infisical CLI and everything else an agent runs live in the Modal sandbox image ([src/image.ts](../src/image.ts)), never in this image.

The [Dockerfile](../Dockerfile) builds on `node:22-alpine` and runs as `node` (uid 1000); [docker-compose.yml](../docker-compose.yml) runs it with automatic restart, a volume for the journal, a read-only root filesystem and no capabilities. No configuration is baked into the image: every variable in [.env.example](../.env.example) is supplied at run time ([README configuration](../README.md#configuration)). Leave `STATE_DIR` at its default, `state`, which is `/app/state` in the container, where the volume is mounted.

## Build, configure and run

On the host, from a checkout of this repo:

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env                        # fill in the values
docker compose up -d --build        # build and start
```

| Task | Command |
|---|---|
| Start | `docker compose up -d` |
| Stop | `docker compose stop` (sends SIGTERM; see "Stopping") |
| Status | `docker compose ps` |
| Follow logs | `docker compose logs -f` |
| Recent logs | `docker compose logs --since 1h` |
| Update | `git pull && docker compose up -d --build` |
| Apply a changed `.env` | `docker compose up -d` (recreates the container; `restart` does **not** reread `.env`) |
| Remove container, keep state | `docker compose down` |

Never run `docker compose down -v` on a live deployment: `-v` deletes the state volume and with it the record of anything a crash left behind.

To build an image without compose: `docker build -t apollo .`. Build for the host's architecture: an image built on an Apple Silicon laptop is arm64 unless built with `--platform linux/amd64`.

### Stopping

`docker compose stop` sends SIGTERM, which shuts down as Ctrl-C does locally ([README](../README.md#getting-started)): runs in progress are aborted and cleaned up, then the process exits 0. `stop_grace_period` gives it 60 s for that; if Docker has to SIGKILL it, the next start cleans up from the journal and the tag sweep. An update therefore aborts any run in progress, and its user gets an error reply.

### What is logged

One line per run: the thread, the run, session and sandbox IDs, and step timings. Startup logs the Modal App, the image reference and its built ID, the bundle name, slot count and the proxy CA fingerprint (public), and any leftover sandboxes it terminated. Failures log their error message, and denied messages the sender's Slack user ID. Tokens, client secrets, prompts and answers are not logged. Docker rotates the logs (`logging` in the compose file).

## Testing the container locally

Use the dev Slack app and `.env.local`, as for `npm run start:slack`, and stop any local `npm run start:slack` first: Slack hands each event to one of the open Socket Mode connections, so two processes on the same app split the messages.

```bash
docker build -t apollo .
docker run --rm --name apollo-local \
  --env-file .env.local \
  -v apollo-local-state:/app/state \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  apollo
```

`docker run --env-file` takes values literally, so the file must not quote them or put comments after them. DM the dev bot; the log shows the session and sandbox IDs and the run's timings.

## Agent Proxy on Modal

Every sandbox runs its own Agent Proxy, as a sidecar container next to the agent's ([contract section 5](contract.md#5-network)). All of them are copies of one enrolled proxy: its enrollment and CA live on the Modal Volume `agent-proxy-state`, which each sidecar mounts read-only and copies before starting. Nothing runs between runs. Enroll once, before starting the bot.

The secret, the Volume and the bot must all be in the same Modal environment. The Modal CLI uses the profile's environment unless told otherwise, while the bot uses `MODAL_ENVIRONMENT` from its own configuration, so if you set `MODAL_ENVIRONMENT` in `.env.local`, export the same value in the shell you run these commands from (the CLI reads it too), and create the secret in that environment in the dashboard:

```bash
export MODAL_ENVIRONMENT=<the value from .env.local>   # skip if the bot uses the default environment
```

1. **Create the proxy in Infisical**: Agent Vault, Proxies, create one, and copy its one-time enrollment token (it expires in an hour). Make sure the access bundle in `AGENT_VAULT_ACCESS_BUNDLE` can be used through it.
2. **Store the token in Modal**: a secret named `agent-proxy` with `INFISICAL_AGENT_VAULT_ENROLLMENT_TOKEN`, created in the Modal dashboard so the token stays out of shell history.
3. **Enroll**, with the Modal CLI logged in to the workspace (`pip install modal`, `modal setup`):

```bash
modal run proxy/agent_proxy.py       # enrolls, saves the enrollment on the Volume, prints the CA fingerprint
modal volume ls agent-proxy-state    # proxy.json, ca.key, ca.crt
```

   Running it again is harmless: an enrolled proxy resumes its enrollment and keeps its CA.

4. **Remove the enrollment token** from the `agent-proxy` secret once the Volume holds `proxy.json` (add a placeholder key first if Modal won't leave a secret empty).
5. **Configure the bot**: `AGENT_VAULT_PROXY_VOLUME=agent-proxy-state`, and `AGENT_VAULT_CA_FINGERPRINT` from the proxy's row on the Proxies page (it also appears in the `proxy listening` line the job prints).

The Volume holds the proxy's credentials (an access token that stays valid until revoked in Infisical, and the CA key), so treat read access to the Modal workspace as access to them. To rotate, delete the proxy in Infisical, empty the Volume, and enroll again; the CA changes, so update the fingerprint.

## Deploying

### Host and network

- **Host**: anything that runs Docker and keeps a volume: a small VM is enough (1 vCPU, 1 GB), since the agent work happens in Modal.
- **Inbound**: none for the app. Allow SSH only from admin addresses.
- **Outbound**: HTTPS to Slack (`slack.com`, and `wss-primary.slack.com` for Socket Mode), to `INFISICAL_DOMAIN` (`app.infisical.com`), to Modal's API (`api.modal.com`), and to Docker Hub and the npm registry for builds.
- **Agent Proxy**: a sidecar in every sandbox ([above](#agent-proxy-on-modal)). The bot only talks to Modal's API; the agent reaches the proxy inside its own sandbox.
- **One instance per Slack app**: a second instance would split Slack's events.

### Credentials

- **Modal**: a token for a service user in the workspace, not a person's (`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`). It can create and terminate sandboxes in any App of the environment, so keep it on this host only.
- **Infisical and the proxy CA pin**: as in local development ([README getting started](../README.md#getting-started)), but with a machine identity of its own for the deployment, so a laptop's credentials can be revoked without touching it.
- **Slack**: a production Slack app, separate from the dev app ([docs/slack-app.md](slack-app.md); change the name and display name in the manifest). Its tokens go only in the host's `.env`.
- **Secret storage**: `.env` lives only on the host, owned by root, mode 600. It is gitignored and dockerignored. Prefer fetching it from Infisical at deploy time over copying it by hand.

### Persistent state

The journal in `STATE_DIR` holds only the session and sandbox IDs of runs in progress, written the moment each exists and removed after cleanup. It must survive container recreation and image updates, which the named volume `state` does.

If the host itself is lost, so is the journal. The cost is bounded: an orphaned session expires with its TTL (run timeout plus 5 minutes), and an orphaned sandbox is terminated by Modal at its own timeout. A new host gets a new instance ID, so its sweep doesn't find the old host's sandboxes.

### Restart behavior and monitoring

- `restart: unless-stopped` restarts the container on any exit (crash, OOM, failed startup) with Docker's increasing backoff. Enable Docker at boot: `systemctl enable docker`.
- On every start, Apollo builds or resolves the sandbox image, cleans up whatever the journal lists, and terminates any bot-tagged sandbox left in the App, before taking messages. Slack Socket Mode reconnects on its own after network drops.
- There is no HTTP health endpoint (`PORT` is unused), so the compose file declares no healthcheck. Watch for:
  - **Restart loops**: `docker inspect -f '{{.RestartCount}} {{.State.Status}}' $(docker compose ps -q)`. A rising count means the process keeps exiting (missing config, Slack or Modal auth failure, an image build error); the reason is in `docker compose logs`.
  - **Run errors**: `docker compose logs --since 1h | grep -iE 'error|failed'`.
  - **Leaked sandboxes**: sandboxes in the App tagged `app=apollo` that outlive a run (Modal dashboard, or `modal sandbox list`).
