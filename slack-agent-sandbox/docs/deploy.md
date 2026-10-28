# Deploying Atlas in Docker

Atlas ships as one container that runs the Slack Socket Mode orchestrator (`node dist/src/main.js`). It only makes outbound connections, to Slack, SPACE and Infisical, so it publishes no ports and needs no public URL. The image holds the compiled JavaScript, production dependencies and [instructions/AGENTS.md](../instructions/AGENTS.md). Claude Code, the Infisical CLI and everything else an agent runs live in the SPACE template, never in this image.

The [Dockerfile](../Dockerfile) builds on `node:22-alpine` and runs as `node` (uid 1000); [docker-compose.yml](../docker-compose.yml) runs it with automatic restart, a volume for the journal, a read-only root filesystem and no capabilities. No configuration is baked into the image: every variable in [.env.example](../.env.example) is supplied at run time ([README configuration](../README.md#configuration)). Leave `STATE_DIR` at its default, `state`, which is `/app/state` in the container, where the volume is mounted.

## Build, configure and run

On the host, from a checkout of this folder:

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

To build an image without compose: `docker build -t atlas .`. An image built on an Apple Silicon laptop is arm64 unless built with `--platform linux/amd64`.

### Stopping

`docker compose stop` sends SIGTERM, which shuts down as Ctrl-C does locally ([README](../README.md#run-it-locally)): runs in progress are aborted and cleaned up, then the process exits 0. `stop_grace_period` gives it 60 s for that; if Docker has to SIGKILL it, the next start cleans up from the journal. An update therefore aborts any run in progress, and its user gets an error reply.

### What is logged

One line per run: the thread, the run, session and sandbox IDs, and step timings. Startup logs the template, access bundle name, slot count and the proxy CA fingerprint (public). Failures log their error message, and denied messages the sender's Slack user ID. Tokens, client secrets, prompts and answers are not logged. Docker rotates the logs (`logging` in the compose file).

## Testing the container locally

Use the dev Slack app and `.env.local`, as for `npm run start:slack`, and stop any local `npm run start:slack` first: Slack hands each event to one of the open Socket Mode connections, so two processes on the same app split the messages.

If you reach SPACE through an SSH tunnel on your laptop, the container can't use `localhost`, which is the container itself. On Docker Desktop for Mac, `host.docker.internal` reaches the tunnel on the host's loopback:

```bash
docker build -t atlas .
docker run --rm --name atlas-local \
  --env-file .env.local \
  -e SPACE_API_URL=http://host.docker.internal:8080 \
  -e SPACE_DATA_PLANE_URL=http://host.docker.internal:8090 \
  -v atlas-local-state:/app/state \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  atlas
```

`docker run --env-file` takes values literally, so the file must not quote them or put comments after them. DM the dev bot; the log shows the session and sandbox IDs and the run's timings. Ctrl-C (or `docker stop atlas-local`) shuts down as above.

On Linux, add `--add-host=host.docker.internal:host-gateway`, and bind the tunnel to an address the bridge can reach.

## Network

- **Placement**: run Atlas on its own host in the same private network as SPACE and the proxy. A small host is enough (1 vCPU, 1 GB): the agent work happens in SPACE.
- **Inbound**: none for the app. Allow SSH only from admin addresses.
- **Outbound**: HTTPS to Slack (`slack.com`, and `wss-primary.slack.com` for Socket Mode), to `INFISICAL_DOMAIN`, and to Docker Hub and the npm registry for builds. On the private network, the SPACE management API and data plane (8080 and 8090 by default) and nothing else.
- **The proxy**: Atlas never connects to it. Sandboxes do, through the layers in [section 5 of the API notes](contract.md#5-network-layers). `AGENT_VAULT_PROXY_ADDRESS` is the proxy's private address as the sandboxes reach it.
- **One instance**: run exactly one container per Slack app. A second would split Slack's events, and each instance's recovery only sees its own journal.

### Reaching SPACE

Expose SPACE's management API and data plane on its private address with TLS, either from SPACE itself or a TLS-terminating proxy in front of it, and firewall both ports to Atlas's host. `SPACE_API_URL` and `SPACE_DATA_PLANE_URL` become `https://<private address>:<port>`; Atlas derives `wss://` for the data plane from the `https://` URL.

Plain HTTP is not acceptable even on a private network: the SPACE API token travels on every management call, and each command's attach token on the data plane. If you can't put TLS in front of SPACE yet, a long-running SSH tunnel from Atlas's host, with a dedicated forward-only key, is a workable stopgap.

### TLS and secrets

- **SPACE CA**: if SPACE's certificate is from a private CA, mount the CA certificate read-only and set `NODE_EXTRA_CA_CERTS` to it in `.env`. Node then trusts it for both the HTTP calls and the data-plane WebSocket. `SPACE_CA_FILE` is not used by the SPACE client yet, so it has no effect on its own.
- **Infisical and the proxy CA pin**: as in local development, but with a machine identity of its own for the deployment, so a laptop's credentials can be revoked without touching it.
- **Slack**: a production Slack app, separate from the dev app ([docs/slack-app.md](slack-app.md)). Its tokens go only in the deployed `.env`.
- **Secret storage**: `.env` lives only on the host, owned by root, mode 600. It is gitignored and dockerignored. Prefer fetching it from Infisical at deploy time over copying it by hand.

### Persistent state

The journal in `STATE_DIR` holds only the session and sandbox IDs of runs in progress, written the moment each exists and removed after cleanup. It must survive container recreation and image updates, which the named volume `state` does.

- If the host itself is lost, so is the journal. The cost is bounded: an orphaned session expires with its TTL, and an orphaned sandbox can be found by its metadata and deleted ([README operating notes](../README.md#operating-notes)). Bind-mount a persistent disk at `/app/state` (`chown 1000:1000`) if state should outlive the host.
- Back up nothing else: the container is otherwise stateless.

### Token rotation

Rotate `SPACE_API_TOKEN`, the Infisical client secret and the Slack tokens the same way: update `.env` and run `docker compose up -d`. This recreates the container, aborting any run in progress. An expired token shows up as `401` errors in the logs, and every run replies with an error. The container keeps running: startup cleanup that fails keeps its records for the next start, which cleans them up once the token is replaced.

### Restart behavior and monitoring

- `restart: unless-stopped` restarts the container on any exit (crash, OOM, failed startup) with Docker's increasing backoff, and after host or Docker reboots, unless it was stopped by hand. Enable Docker at boot: `systemctl enable docker`.
- On every start, Atlas cleans up whatever the journal lists before taking messages. Slack Socket Mode reconnects on its own after network drops.
- There is no HTTP health endpoint, so the compose file declares no healthcheck. Watch for:
  - **Restart loops**: `docker inspect -f '{{.RestartCount}} {{.State.Status}}' $(docker compose ps -q)`. A rising count means the process keeps exiting (missing config, Slack auth failure, a crash); the reason is in `docker compose logs`.
  - **Run errors**: `docker compose logs --since 1h | grep -iE 'error|failed'`.
  - **Leaked sandboxes**: sandboxes with `metadata.app = atlas` that outlive a run.
  - **Token expiry**, above.
