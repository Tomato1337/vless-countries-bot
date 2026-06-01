# Docker deployment and documentation design

## Goal

Package `vless-countries-bot` as a Docker Compose service that can be deployed
on the RU server with a small, repeatable command sequence. Add operator
documentation for installation, 3x-ui configuration, updates, backups,
troubleshooting, and smoke tests.

The bot is a control-plane application. It talks to Telegram, NordVPN public
APIs, and an already reachable 3x-ui HTTPS endpoint. Xray and NordLynx remain
managed by 3x-ui on the RU server; they do not run inside the bot container.

## Network model

Use the default Docker bridge network with outbound internet access.

`XUI_BASE_URL` points to the existing HTTPS address of 3x-ui, including its
secret panel path:

```env
XUI_BASE_URL=https://panel.example.com/secret-panel-path
```

The HTTPS endpoint must use a certificate trusted by the container runtime,
such as a Let's Encrypt certificate. The Compose service does not use
`network_mode: host`, `host.docker.internal`, published ports, privileged mode,
`NET_ADMIN`, or `/dev/net/tun`.

This keeps the bot isolated from the host network while allowing it to reach:

- Telegram Bot API for grammY long polling.
- NordVPN public catalog APIs.
- The existing 3x-ui HTTPS endpoint.

## Container image

Add a multi-stage `Dockerfile` based on the pinned official
`oven/bun:1.3.8-slim` image.

The dependency stage installs production dependencies with:

```bash
bun install --frozen-lockfile --production
```

The runtime stage copies the application source and production dependencies,
runs as the non-root `bun` user, declares `/app/data` as the persistent data
directory, and starts:

```bash
bun index.ts
```

The image contains no `.env`, SQLite database, backups, logs, development
caches, or local dependencies.

## Compose service

Add `compose.yaml` with one service named `bot`.

The service:

- Builds the image locally from the repository checkout.
- Loads secrets and settings from `.env`.
- Overrides `DATABASE_PATH=/app/data/bot.sqlite`.
- Mounts `./data:/app/data`.
- Uses `restart: unless-stopped`.
- Uses the default Docker bridge network.
- Defines a healthcheck with `bun index.ts --check`.
- Does not publish any ports.

Before the first start, the deployment guide creates `./data` with permissions
that allow the non-root container user to create `bot.sqlite`. The SQLite file
itself is still created and maintained by the application with mode `0600`.

## Configuration interface

Keep the existing `.env.example` as the canonical configuration template and
document both local and Docker behavior.

For Docker deployment:

```env
XUI_BASE_URL=https://panel.example.com/secret-panel-path
```

The operator can leave `DATABASE_PATH=./data/bot.sqlite` unchanged in `.env`.
Compose overrides it with `/app/data/bot.sqlite` inside the container.

`NORDVPN_PRIVATE_KEY` remains optional. Manual VLESS exits work without it.

No secret is baked into the image or committed to Git.

## Documentation structure

Keep `README.md` as the landing page:

- Purpose and traffic flow.
- Feature summary.
- Supported 3x-ui version.
- Quick Docker Compose start.
- Links to detailed guides.
- Local development commands.

Add `docs/deployment.md`:

- Server prerequisites.
- Docker and Compose deployment.
- `.env` creation.
- Data directory permissions.
- Start, stop, logs, health, and compatibility checks.
- Upgrade flow using `git pull`, rebuild, and restart.
- SQLite backup and restore.
- Removal without accidentally deleting data.

Add `docs/configuration.md`:

- Required `.env` variables.
- 3x-ui inbound and Germany transit outbound assumptions.
- HTTPS panel URL requirements.
- NordVPN NordLynx private key format.
- Subscription `subId`, `Remark Model`, and profile naming.
- Supported manual VLESS transports.
- Why NordVPN outbounds use `transportLayer`, userspace TUN, and MTU `1280`.

Add `docs/operations.md`:

- Telegram permissions and commands.
- Button-driven NordVPN workflow.
- Safe apply, backup, rollback, and Xray restart behavior.
- Manual VLESS and NordVPN ownership boundaries.
- Region Repair behavior.
- Smoke-test checklist.
- Troubleshooting table for authentication, routing, subscription, latency,
  and pending-download symptoms.

## Validation

Add a Docker-specific static validation path:

```bash
docker compose config
docker compose build
docker compose run --rm bot bun index.ts --check
```

The final implementation verification also runs:

```bash
bun test
bun run typecheck
git diff --check
```

If Docker is unavailable in the development environment, report that image
build and container execution could not be verified locally. The Compose
configuration should still be checked statically where possible.

## Operational constraints

- The bot container must not run Xray.
- The bot container must not require host networking.
- The bot container must not expose ports.
- The bot container must not contain secrets or SQLite data.
- Existing non-Docker local startup with `bun run start` remains supported.
- Existing managed exit behavior and Telegram commands remain unchanged.
