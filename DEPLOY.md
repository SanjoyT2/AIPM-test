# Deploying to AWS EC2

Pushing to `main` builds a Docker image, publishes it to GHCR, and restarts the
container on the EC2 box. `.github/workflows/deploy.yml` is the whole pipeline;
`docker-compose.prod.yml` is what actually runs on the server.

## The infrastructure

| Thing | Value |
|---|---|
| Region | `ap-south-1` (Mumbai) |
| Instance | `D2D` — `t3.small`, Amazon Linux 2023, 20 GB gp3 (encrypted), `i-0525e1f26e0c1fb6b` |
| Elastic IP | `35.154.20.8` — fixed, survives stop/start |
| Domain | `d2d.college2career.app` |
| TLS | Caddy sidecar, automatic Let's Encrypt; certs persist in the `caddy_data` volume |
| Security group | `D2D-sg` — inbound 22, 80, 443 |
| Instance role | `D2D-ec2-role` — SSM access, so you can get a shell without SSH |
| App directory | `/opt/d2d` (`docker-compose.prod.yml`, `Caddyfile`, `.env`) |
| Image | `ghcr.io/sanjoyt2/aipm-test`, tagged with the commit SHA |

The database is **MongoDB Atlas**, not on this box. Collections are created on demand,
so there is no migration step.

## URL layout

| Path | Serves |
|---|---|
| `/` | Public landing page (`join.html`) — the student signup funnel |
| `/join`, `/start` | Same landing page |
| `/app` | Operator console (React SPA, router `basename="/app"`) |
| `/api/*` | JSON API |
| `/webhooks/11za` | Inbound WhatsApp |

`fastify-static` is registered with `index: false` so `/` stays free for the landing
page. Adding a static file at the root without that flag would collide with the route.

## Required secrets

Set under Settings → Secrets and variables → Actions.

| Secret | Required? | Notes |
|---|---|---|
| `EC2_HOST` | set | Elastic IP of the box |
| `EC2_SSH_KEY` | set | Private half of the `aipm-test-deploy` key pair |
| `DATABASE_URL` | **yes** | MongoDB Atlas connection string (`mongodb+srv://…`) |
| `OPERATOR_KEY` | **yes** | Gates every curriculum and learner write. See below |
| `OPENAI_API_KEY` | no | Omit to run the LLM gateway in stub mode |
| `WA_API_TOKEN`, `WA_API_BASE`, `WA_ORIGIN_WEBSITE`, `WA_WEBHOOK_SECRET` | no | 11za WhatsApp; omit for outbound stub mode |

Optional repo *variables* `MODEL_FAST` / `MODEL_DEEP` override the model tiers
(defaults `gpt-4o-mini` / `gpt-4o`).

The workflow renders these into `/opt/d2d/.env` on every deploy, so that file is
derived state — edit the secrets, not the file.

## The operator key

Everything that writes curriculum or learner records requires the
`x-operator-key` header: creating courses, modules and lessons, publishing,
enrolling, setting a project, driving a journey, and reading the signups roster
(which is learner PII).

It **fails closed in production**: if `OPERATOR_KEY` is unset, those routes return
`503` rather than running unauthenticated. Outside production they log a warning and
allow the call, so local dev and the seed scripts still work.

In the console, paste the key into the control at the bottom of the sidebar. It is
stored per-browser in `localStorage` and cleared automatically if the server rejects
it. A wrong key returns `401`.

## Operating it

Deploy is automatic on push to `main`, or run the workflow manually:

```bash
gh workflow run deploy.yml --repo SanjoyT2/AIPM-test
```

Get a shell without SSH keys or an open port:

```bash
aws ssm start-session --target i-0525e1f26e0c1fb6b --region ap-south-1
```

Tail the app logs:

```bash
ssh ec2-user@35.154.20.8 'docker compose -f /opt/d2d/docker-compose.prod.yml logs -f api'
```

To roll back, re-run an older successful workflow — images are pinned per commit SHA,
so the previous deploy is still in the registry.

## Known gaps

- **Port 22 is open to the internet** so GitHub-hosted runners can reach it (their IP
  ranges are large and rotate). Auth is key-only. Tightening this means either a
  self-hosted runner or switching the deploy to SSM Send-Command.
- **The host key is trusted on first use** (`ssh-keyscan` in the workflow) rather than
  pinned to a known fingerprint.
- **The console has no user accounts** — the operator key is a single shared secret,
  not per-coach identity. Fine for one operator; revisit before handing it to a team.
